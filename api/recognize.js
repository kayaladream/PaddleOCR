// api/recognize.js

const BAIDU_JOB_URL = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs';

function parseOtslToHtml(text) {
  if (!text.includes('<nl>') && !text.includes('<fcel>')) {
    return text;
  }

  try {
    let html = '<table class="markdown-table" style="border-collapse: collapse;" border="1"><tbody>\n';
    const rows = text.split('<nl>').filter(r => r.trim() !== '');

    rows.forEach(row => {
      html += '  <tr>\n';

      const cells = row
        .split(/(?=<fcel>|<ucel>)/)
        .filter(c => c.trim() !== '');

      cells.forEach(cell => {
        const colspan = 1 + (cell.match(/<lcel>/g) || []).length;
        const rowspan = 1 + (cell.match(/<ucel>/g) || []).length;

        const cellText = cell
          .replace(/<fcel>|<lcel>|<ucel>|<ecel>/g, '')
          .trim();

        if (cellText === '' && !cell.includes('<fcel>')) {
          return;
        }

        const attrs = [];

        if (colspan > 1) {
          attrs.push(`colspan="${colspan}"`);
        }

        if (rowspan > 1) {
          attrs.push(`rowspan="${rowspan}"`);
        }

        html += `    <td ${attrs.join(' ')}>${cellText}</td>\n`;
      });

      html += '  </tr>\n';
    });

    html += '</tbody></table>\n\n';

    return html;
  } catch (err) {
    console.error('OTSL 解析为 HTML 失败:', err);
    return text;
  }
}

function stripSiliconArtifacts(text) {
  let rawText = text || '';

  if (!rawText) {
    return '';
  }

  rawText = parseOtslToHtml(rawText);

  rawText = rawText.replace(
    /^.*<\|ref\|>.*<\/\|ref\|>.*$/gm,
    ''
  );

  rawText = rawText.replace(
    /^.*<\|det\|>.*<\/\|det\|>.*$/gm,
    ''
  );

  rawText = rawText.replace(
    /<\|?LOC[^>]*\|?>/g,
    ''
  );

  rawText = rawText
    .replace(/<\|ref\|>/g, '')
    .replace(/<\/\|ref\|>/g, '');

  rawText = rawText
    .replace(/<\|det\|>/g, '')
    .replace(/<\/\|det\|>/g, '');

  rawText = rawText.replace(/\n{3,}/g, '\n\n');

  return rawText.trim();
}

async function readResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      rawText: text
    };
  }
}

function getBaiduModel(modelId) {
  switch (modelId) {
    case 'baidu-vl-1.6':
      return 'PaddleOCR-VL';

    case 'baidu-vl-1.5':
      // 兼容旧前端缓存/旧链接。
      // 当前百度官方文档解析服务已经使用新版 PaddleOCR-VL 服务。
      return 'PaddleOCR-VL';

    case 'baidu-ocrv5':
      return 'PP-OCRv5';

    case 'baidu-structurev3':
      return 'PP-StructureV3';

    default:
      return 'PaddleOCR-VL';
  }
}

function getBaiduOptionalPayload(modelName) {
  if (modelName === 'PP-OCRv5') {
    return {
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      useTextlineOrientation: false
    };
  }

  return {
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useChartRecognition: false
  };
}

function getFileExtension(mimeType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/avif': 'avif',
    'application/pdf': 'pdf'
  };

  return map[mimeType] || 'bin';
}

function base64ToBlob(imageData, mimeType) {
  const normalized = String(imageData || '')
    .replace(/^data:[^;]+;base64,/, '');

  const buffer = Buffer.from(normalized, 'base64');

  return new Blob(
    [buffer],
    {
      type: mimeType || 'application/octet-stream'
    }
  );
}

async function submitBaiduJob({
  imageData,
  mimeType,
  modelId,
  token
}) {
  const model = getBaiduModel(modelId);

  const optionalPayload = getBaiduOptionalPayload(model);

  const form = new FormData();

  form.append(
    'model',
    model
  );

  form.append(
    'optionalPayload',
    JSON.stringify(optionalPayload)
  );

  const extension = getFileExtension(mimeType);

  const filename = `upload.${extension}`;

  const fileBlob = base64ToBlob(
    imageData,
    mimeType
  );

  form.append(
    'file',
    fileBlob,
    filename
  );

  const response = await fetch(
    BAIDU_JOB_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    }
  );

  const data = await readResponseBody(
    response
  );

  if (!response.ok) {
    const detail =
      data?.msg ||
      data?.message ||
      data?.data?.errorMsg ||
      data?.rawText ||
      `HTTP ${response.status}`;

    throw new Error(
      `百度 PaddleOCR 任务提交失败（${response.status}）：${detail}`
    );
  }

  if (
    data?.code &&
    Number(data.code) !== 0
  ) {
    const detail =
      data?.msg ||
      data?.data?.errorMsg ||
      '未知错误';

    throw new Error(
      `百度 PaddleOCR 任务提交失败（code ${data.code}）：${detail}`
    );
  }

  const jobId = data?.data?.jobId;

  if (!jobId) {
    throw new Error(
      `百度 PaddleOCR 返回中没有 jobId：${JSON.stringify(data)}`
    );
  }

  return {
    jobId,
    model
  };
}

function extractBaiduTextFromResult(
  result,
  model
) {
  if (!result) {
    return '';
  }

  // =========================
  // PP-OCRv5
  // =========================
  if (model === 'PP-OCRv5') {
    const parts = [];

    for (
      const item of result.ocrResults || []
    ) {
      const recTexts =
        item?.prunedResult?.rec_texts ||
        item?.rec_texts ||
        [];

      if (Array.isArray(recTexts)) {
        parts.push(
          ...recTexts.filter(Boolean)
        );
      }
    }

    if (parts.length > 0) {
      return parts.join('\n').trim();
    }

    return '';
  }

  // =========================
  // PaddleOCR-VL / PP-StructureV3
  // =========================
  const parts = [];

  for (
    const item of result.layoutParsingResults || []
  ) {
    const text =
      item?.markdown?.text;

    if (
      typeof text === 'string' &&
      text.trim()
    ) {
      parts.push(
        text.trim()
      );
    }
  }

  return parts
    .join('\n\n')
    .trim();
}

async function fetchBaiduJsonl(
  jsonlUrl,
  model
) {
  if (!jsonlUrl) {
    throw new Error(
      '百度 PaddleOCR 任务完成，但没有返回 resultUrl.jsonUrl。'
    );
  }

  const response = await fetch(
    jsonlUrl,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*'
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `百度 PaddleOCR 结果下载失败（${response.status}）：${text}`
    );
  }

  const text = await response.text();

  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const pageTexts = [];

  for (
    const line of lines
  ) {
    let parsed;

    try {
      parsed = JSON.parse(line);
    } catch (error) {
      console.error(
        '百度 JSONL 某行解析失败:',
        error
      );

      continue;
    }

    const result =
      parsed?.result;

    if (!result) {
      continue;
    }

    const extracted =
      extractBaiduTextFromResult(
        result,
        model
      );

    if (extracted) {
      pageTexts.push(
        extracted
      );
    }
  }

  return pageTexts
    .join('\n\n')
    .trim();
}

async function runBaiduAsyncOCR({
  imageData,
  mimeType,
  modelId,
  token
}) {
  if (!token) {
    throw new Error(
      '环境变量未设置：请配置 PADDLE_TOKEN。'
    );
  }

  const {
    jobId,
    model
  } = await submitBaiduJob({
    imageData,
    mimeType,
    modelId,
    token
  });

  console.log(
    `百度 PaddleOCR 任务提交成功：jobId=${jobId}, model=${model}`
  );

  // 百度官方异步任务模式。
  // 每 6 秒查询一次。
  // 最多轮询 25 次。
  // 理论最大等待约 150 秒。
  const maxPollAttempts = 25;
  const pollIntervalMs = 6000;

  for (
    let attempt = 1;
    attempt <= maxPollAttempts;
    attempt += 1
  ) {
    const response = await fetch(
      `${BAIDU_JOB_URL}/${encodeURIComponent(jobId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data =
      await readResponseBody(
        response
      );

    if (!response.ok) {
      const detail =
        data?.msg ||
        data?.message ||
        data?.data?.errorMsg ||
        data?.rawText ||
        `HTTP ${response.status}`;

      throw new Error(
        `百度 PaddleOCR 查询任务失败（${response.status}）：${detail}`
      );
    }

    if (
      data?.code &&
      Number(data.code) !== 0
    ) {
      const detail =
        data?.msg ||
        data?.data?.errorMsg ||
        '未知错误';

      throw new Error(
        `百度 PaddleOCR 查询任务失败（code ${data.code}）：${detail}`
      );
    }

    const task =
      data?.data || {};

    const state =
      task.state;

    console.log(
      `百度 PaddleOCR 任务状态：${state || 'unknown'}，第 ${attempt}/${maxPollAttempts} 次轮询`
    );

    // =========================
    // 完成
    // =========================
    if (state === 'done') {
      const jsonlUrl =
        task?.resultUrl?.jsonUrl;

      return await fetchBaiduJsonl(
        jsonlUrl,
        model
      );
    }

    // =========================
    // 失败
    // =========================
    if (state === 'failed') {
      throw new Error(
        `百度 PaddleOCR 解析失败：${task?.errorMsg || '官方接口未提供具体失败原因'}`
      );
    }

    // =========================
    // 正常等待状态
    // =========================
    if (
      state !== 'pending' &&
      state !== 'running'
    ) {
      throw new Error(
        `百度 PaddleOCR 返回了未知任务状态：${state || '空状态'}`
      );
    }

    if (
      attempt < maxPollAttempts
    ) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            pollIntervalMs
          )
      );
    }
  }

  throw new Error(
    '百度 PaddleOCR 任务等待超时：已轮询约 150 秒仍未完成。'
  );
}

async function autoDetectPrompt(
  imageData,
  mimeType,
  token
) {
  try {
    if (!token) {
      return 'ERROR:';
    }

    const response = await fetch(
      'https://api.siliconflow.cn/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Qwen/Qwen3-VL-32B-Instruct',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${imageData}`
                  }
                },
                {
                  type: 'text',
                  text:
                    '请判断这张图片的主要核心内容属于哪一类：\n' +
                    'A. 纯文字\n' +
                    'B. 表格\n' +
                    'C. 数学公式\n' +
                    '你只能输出一个大写字母，不要包含任何标点符号和多余废话。'
                }
              ]
            }
          ],
          max_tokens: 5,
          temperature: 0.1
        })
      }
    );

    if (!response.ok) {
      return 'ERROR:';
    }

    const data =
      await response.json();

    const reply =
      data?.choices?.[0]?.message?.content
        ?.trim()
        .toUpperCase() ||
      'A';

    if (reply.includes('B')) {
      console.log(
        '🖼️ 路由器检测为：表格 -> 使用 Table Recognition:'
      );

      return 'Table Recognition:';
    }

    if (reply.includes('C')) {
      console.log(
        '🖼️ 路由器检测为：公式 -> 使用 Formula Recognition:'
      );

      return 'Formula Recognition:';
    }

    console.log(
      '🖼️ 路由器检测为：纯文本 -> 使用 OCR:'
    );

    return 'OCR:';
  } catch (error) {
    console.error(
      '路由分类请求出错:',
      error
    );

    return 'ERROR:';
  }
}

export default async function handler(
  req,
  res
) {
  if (req.method !== 'POST') {
    return res
      .status(405)
      .json({
        error: '仅支持POST请求'
      });
  }

  try {
    const {
      imageData,
      mimeType,
      modelId = 'baidu-vl-1.6',
      channel = 'baidu',
      apiName,
      classifyOnly = false
    } = req.body || {};

    if (!imageData || !mimeType) {
      return res
        .status(400)
        .json({
          error:
            '缺少 imageData 或 mimeType 参数'
        });
    }

    let recognizedText = '';
    let routerLabel = null;

    // ============================================
    // 仅分类模式
    // 只有硅基流动 PaddleOCR-VL-1.5 使用
    // ============================================
    if (
      classifyOnly &&
      channel === 'silicon' &&
      apiName ===
        'PaddlePaddle/PaddleOCR-VL-1.5'
    ) {
      const dynamicPrompt =
        await autoDetectPrompt(
          imageData,
          mimeType,
          process.env.SILICON_TOKEN
        );

      if (dynamicPrompt === 'ERROR:') {
        routerLabel =
          '路由分类服务异常，使用默认OCR';
      } else if (
        dynamicPrompt?.includes('Table')
      ) {
        routerLabel = '表格';
      } else if (
        dynamicPrompt?.includes('Formula')
      ) {
        routerLabel = '公式';
      } else if (
        dynamicPrompt?.includes('OCR:')
      ) {
        routerLabel = '纯文本';
      }

      return res.json({
        routerResult: routerLabel
      });
    }

    // ============================================
    // 渠道一：百度 AI Studio
    // 新版异步 API
    // ============================================
    if (channel === 'baidu') {
      recognizedText =
        await runBaiduAsyncOCR({
          imageData,
          mimeType,
          modelId,
          token:
            process.env.PADDLE_TOKEN
        });
    }

    // ============================================
    // 渠道二：硅基流动
    // ============================================
    else if (channel === 'silicon') {
      const url =
        'https://api.siliconflow.cn/v1/chat/completions';

      let config = {};

      // ============================================
      // DeepSeek-OCR
      // ============================================
      if (
        apiName ===
        'deepseek-ai/DeepSeek-OCR'
      ) {
        config = {
          userText:
            '<image>\n<|grounding|>Convert the document to markdown.',
          temperature: 0.0,
          top_p: 1.0,
          frequency_penalty: 0.0,
          presence_penalty: 0.0
        };
      }

      // ============================================
      // PaddleOCR-VL-1.5
      // ============================================
      else if (
        apiName ===
        'PaddlePaddle/PaddleOCR-VL-1.5'
      ) {
        const dynamicPrompt =
          await autoDetectPrompt(
            imageData,
            mimeType,
            process.env.SILICON_TOKEN
          );

        if (dynamicPrompt === 'ERROR:') {
          routerLabel =
            '路由分类服务异常，使用默认OCR';
        } else if (
          dynamicPrompt?.includes('Table')
        ) {
          routerLabel = '表格';
        } else if (
          dynamicPrompt?.includes('Formula')
        ) {
          routerLabel = '公式';
        } else if (
          dynamicPrompt?.includes('OCR:')
        ) {
          routerLabel = '纯文本';
        }

        const promptForOCR =
          dynamicPrompt === 'ERROR:'
            ? 'OCR:'
            : dynamicPrompt;

        config = {
          userText: promptForOCR,
          temperature: 0.0,
          top_p: 1.0,
          frequency_penalty: 0.08,
          presence_penalty: 0.05
        };
      }

      // ============================================
      // 其他硅基模型
      // ============================================
      else {
        config = {
          userText:
            '<image>\nFree OCR.',
          temperature: 0.0,
          top_p: 1.0
        };
      }

      const content = [
        {
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${imageData}`
          }
        }
      ];

      if (
        config.userText &&
        config.userText.trim() !== ''
      ) {
        content.push({
          type: 'text',
          text: config.userText
        });
      }

      const payload = {
        model: apiName,
        messages: [
          {
            role: 'user',
            content
          }
        ],
        max_tokens: 4096,

        ...(config.temperature !== undefined && {
          temperature:
            config.temperature
        }),

        ...(config.top_p !== undefined && {
          top_p:
            config.top_p
        }),

        ...(config.frequency_penalty !== undefined && {
          frequency_penalty:
            config.frequency_penalty
        }),

        ...(config.presence_penalty !== undefined && {
          presence_penalty:
            config.presence_penalty
        })
      };

      const response = await fetch(
        url,
        {
          method: 'POST',
          headers: {
            Authorization:
              `Bearer ${process.env.SILICON_TOKEN}`,
            'Content-Type':
              'application/json'
          },
          body:
            JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        const errText =
          await response.text();

        throw new Error(
          `硅基流动 API 返回状态码 ${response.status} - ${errText}`
        );
      }

      const data =
        await response.json();

      recognizedText =
        stripSiliconArtifacts(
          data?.choices?.[0]?.message?.content ||
            ''
        );
    }

    // ============================================
    // 不支持的渠道
    // ============================================
    else {
      return res
        .status(400)
        .json({
          error:
            '不支持的模型渠道'
        });
    }

    // ============================================
    // 没有识别结果
    // ============================================
    if (
      !recognizedText ||
      !recognizedText.trim()
    ) {
      return res.json({
        text:
          '> ⚠️ **系统提示：当前图片未检测到任何可识别的文本，或遇到异常无法解析。**'
      });
    }

    const responsePayload = {
      text: recognizedText
    };

    // ============================================
    // 返回硅基流动 PaddleOCR-VL 路由结果
    // ============================================
    if (
      channel === 'silicon' &&
      apiName ===
        'PaddlePaddle/PaddleOCR-VL-1.5' &&
      routerLabel
    ) {
      responsePayload.routerResult =
        routerLabel;
    }

    return res.json(
      responsePayload
    );
  } catch (error) {
    console.error(
      '识别失败:',
      error
    );

    return res
      .status(500)
      .json({
        error:
          error?.message ||
          '识别失败，请稍后重试'
      });
  }
}
