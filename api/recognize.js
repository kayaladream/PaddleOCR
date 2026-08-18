// api/recognize.js
function parseOtslToHtml(text) {
  if (!text.includes('<nl>') && !text.includes('<fcel>')) {
    return text;
  }

  try {
    let html = '<table class="markdown-table" style="border-collapse: collapse;" border="1"><tbody>\n';
    const rows = text.split('<nl>').filter(r => r.trim() !== '');
    rows.forEach(row => {
      html += '  <tr>\n';
      const cells = row.split(/(?=<fcel>|<ucel>)/).filter(c => c.trim() !== '');
      cells.forEach(cell => {
        const colspan = 1 + (cell.match(/<lcel>/g) || []).length;
        const rowspan = 1 + (cell.match(/<ucel>/g) || []).length;
        const cellText = cell.replace(/<fcel>|<lcel>|<ucel>|<ecel>/g, '').trim();
        if (cellText === '' && !cell.includes('<fcel>')) return;
        let attrs = [];
        if (colspan > 1) attrs.push(`colspan="${colspan}"`);
        if (rowspan > 1) attrs.push(`rowspan="${rowspan}"`);
        html += `    <td ${attrs.join(' ')}>${cellText}</td>\n`;
      });
      html += '  </tr>\n';
    });
    html += '</tbody></table>\n\n';
    return html;
  } catch (err) {
    console.error("OTSL 解析为 HTML 失败:", err);
    return text;
  }
}

async function autoDetectPrompt(imageData, mimeType, token) {
  try {
    const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'Qwen/Qwen3-VL-32B-Instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } },
            { type: 'text', text: '请判断这张图片的主要核心内容属于哪一类：\nA. 纯文字\nB. 表格\nC. 数学公式\n你只能输出一个大写字母，不要包含任何标点符号和多余废话。' }
          ]
        }],
        max_tokens: 5,
        temperature: 0.1,
      }),
    });

    if (!response.ok) return 'ERROR:';

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content?.trim().toUpperCase() || 'A';

    if (reply.includes('B')) {
      console.log('🖼️ 路由器检测为：表格 -> 使用 Table Recognition:');
      return 'Table Recognition:';
    }
    if (reply.includes('C')) {
      console.log('🖼️ 路由器检测为：公式 -> 使用 Formula Recognition:');
      return 'Formula Recognition:';
    }
    console.log('🖼️ 路由器检测为：纯文本 -> 使用 OCR:');
    return 'OCR:';
  } catch (error) {
    console.error('路由分类请求出错:', error);
    return 'ERROR:';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '仅支持POST请求' });
  }

  try {
    const {
      imageData,
      mimeType,
      modelId = 'baidu-vl-1.5',
      channel = 'baidu',
      apiName,
      classifyOnly = false
    } = req.body;

    if (!imageData || !mimeType) {
      return res.status(400).json({ error: '缺少 imageData 或 mimeType 参数' });
    }

    let recognizedText = '';
    let routerLabel = null;

    // 仅分类模式
    if (classifyOnly && channel === 'silicon' && apiName === 'PaddlePaddle/PaddleOCR-VL-1.5') {
      const dynamicPrompt = await autoDetectPrompt(imageData, mimeType, process.env.SILICON_TOKEN);
      if (dynamicPrompt === 'ERROR:') {
        routerLabel = '路由分类服务异常，使用默认OCR';
      } else if (dynamicPrompt?.includes('Table')) {
        routerLabel = '表格';
      } else if (dynamicPrompt?.includes('Formula')) {
        routerLabel = '公式';
      } else if (dynamicPrompt?.includes('OCR:')) {
        routerLabel = '纯文本';
      }
      return res.json({ routerResult: routerLabel });
    }

// ============================================
// 渠道一：Aistudio Baidu (V2 异步 API)
// ============================================
if (channel === 'baidu') {
  const token = process.env.PADDLE_TOKEN;
  if (!token) {
    throw new Error('环境变量未设置：请配置 PADDLE_TOKEN');
  }

  // 模型名称映射（新版 API 的模型名）
  const modelNameMap = {
    'baidu-vl-1.5': 'PaddleOCR-VL-1.6',
    'baidu-ocrv5': 'PP-OCRv6',
    'baidu-structurev3': 'PP-StructureV3'
  };
  const model = modelNameMap[modelId] || 'PaddleOCR-VL-1.6';

  // 构建可选参数（根据模型不同）
  const optionalPayload = {};
  // 先尝试空对象，如果后续需要可再添加

  // 1. 提交任务（使用 Buffer）
  const submitUrl = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs';
  const formData = new FormData();
  const buffer = Buffer.from(imageData, 'base64');
  // 直接 append buffer，并指定文件名和 Content-Type
  formData.append('file', buffer, { filename: 'upload.jpg', contentType: mimeType });
  formData.append('model', model);
  if (Object.keys(optionalPayload).length > 0) {
    formData.append('optionalPayload', JSON.stringify(optionalPayload));
  }

  const submitRes = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${token}`,
    },
    body: formData,
  });

  const submitText = await submitRes.text();
  let submitData;
  try {
    submitData = JSON.parse(submitText);
  } catch {
    throw new Error(`提交任务返回非JSON: ${submitText}`);
  }

  if (!submitRes.ok) {
    throw new Error(`提交任务失败 (${submitRes.status}): ${submitData?.message || submitText}`);
  }

  const jobId = submitData?.data?.jobId;
  if (!jobId) {
    throw new Error(`未获取到 jobId: ${JSON.stringify(submitData)}`);
  }

  // 2. 轮询结果
  const maxAttempts = 120; // 4分钟
  const pollInterval = 2000;
  let jsonlUrl = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const statusRes = await fetch(`https://paddleocr.aistudio-app.com/api/v2/ocr/jobs/${jobId}`, {
      headers: { 'Authorization': `bearer ${token}` }
    });
    const statusText = await statusRes.text();
    let statusData;
    try {
      statusData = JSON.parse(statusText);
    } catch {
      throw new Error(`轮询返回非JSON: ${statusText}`);
    }
    if (!statusRes.ok) {
      throw new Error(`轮询状态失败 (${statusRes.status}): ${statusData?.message || statusText}`);
    }
    const state = statusData?.data?.state;
    if (state === 'done') {
      jsonlUrl = statusData?.data?.resultUrl?.jsonUrl;
      if (!jsonlUrl) {
        throw new Error(`任务完成但未返回 jsonUrl: ${JSON.stringify(statusData)}`);
      }
      break;
    } else if (state === 'failed') {
      const errorMsg = statusData?.data?.errorMsg || '未知错误';
      throw new Error(`任务失败: ${errorMsg}`);
    }
    // pending 或 running 继续等待
    await new Promise(r => setTimeout(r, pollInterval));
  }
  if (!jsonlUrl) {
    throw new Error('轮询超时，未获取到结果');
  }

  // 3. 下载 JSONL 结果
  const resultRes = await fetch(jsonlUrl);
  if (!resultRes.ok) {
    throw new Error(`获取结果失败 (${resultRes.status}): ${await resultRes.text()}`);
  }
  const resultText = await resultRes.text();

  // 4. 解析 JSONL 并提取文本
  const lines = resultText.split('\n').filter(line => line.trim() !== '');
  let allText = '';
  for (const line of lines) {
    const entry = JSON.parse(line);
    const result = entry.result;
    if (model === 'PP-OCRv6') {
      const ocrResults = result?.ocrResults || [];
      const texts = ocrResults.flatMap(r => r?.prunedResult?.rec_texts || []);
      allText += texts.join('\n') + '\n';
    } else {
      const layoutResults = result?.layoutParsingResults || [];
      for (const resItem of layoutResults) {
        allText += (resItem?.markdown?.text || '') + '\n';
      }
    }
  }
  recognizedText = allText.trim();
}

    // ============================================
    // 渠道二：硅基流动 (SiliconFlow)
    // ============================================
    else if (channel === 'silicon') {
      const url = 'https://api.siliconflow.cn/v1/chat/completions';
      let config = {};

      if (apiName === 'deepseek-ai/DeepSeek-OCR') {
        config = {
          userText: '<image>\n<|grounding|>Convert the document to markdown.',
          temperature: 0.0,
          top_p: 1.0,
          frequency_penalty: 0.0,
          presence_penalty: 0.0,
        };
      } else if (apiName === 'PaddlePaddle/PaddleOCR-VL-1.5') {
        const dynamicPrompt = await autoDetectPrompt(imageData, mimeType, process.env.SILICON_TOKEN);

        if (dynamicPrompt === 'ERROR:') {
          routerLabel = '路由分类服务异常，使用默认OCR';
        } else if (dynamicPrompt?.includes('Table')) {
          routerLabel = '表格';
        } else if (dynamicPrompt?.includes('Formula')) {
          routerLabel = '公式';
        } else if (dynamicPrompt?.includes('OCR:')) {
          routerLabel = '纯文本';
        }

        const promptForOCR = (dynamicPrompt === 'ERROR:') ? 'OCR:' : dynamicPrompt;

        config = {
          userText: promptForOCR,
          temperature: 0.0,
          top_p: 1.0,
          frequency_penalty: 0.08,
          presence_penalty: 0.05,
        };
      } else {
        config = {
          userText: '<image>\nFree OCR.',
          temperature: 0.0,
          top_p: 1.0,
        };
      }

      const content = [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } }];
      if (config.userText && config.userText.trim() !== '') {
        content.push({ type: 'text', text: config.userText });
      }

      const payload = {
        model: apiName,
        messages: [{ role: 'user', content }],
        max_tokens: 4096,
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        ...(config.top_p !== undefined && { top_p: config.top_p }),
        ...(config.frequency_penalty !== undefined && { frequency_penalty: config.frequency_penalty }),
        ...(config.presence_penalty !== undefined && { presence_penalty: config.presence_penalty }),
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SILICON_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`硅基流动 API 返回状态码 ${response.status} - ${errText}`);
      }

      const data = await response.json();
      let rawText = data?.choices?.[0]?.message?.content || '';

      if (rawText) {
        rawText = parseOtslToHtml(rawText);
        rawText = rawText.replace(/^.*<\|ref\|>.*<\/\|ref\|>.*$/gm, '');
        rawText = rawText.replace(/^.*<\|det\|>.*<\/\|det\|>.*$/gm, '');
        rawText = rawText.replace(/<\|?LOC[^>]*\|?>/g, '');
        rawText = rawText.replace(/<\|ref\|>/g, '').replace(/<\/\|ref\|>/g, '');
        rawText = rawText.replace(/<\|det\|>/g, '').replace(/<\/\|det\|>/g, '');
        rawText = rawText.replace(/\n{3,}/g, '\n\n');
        recognizedText = rawText.trim();
      }
    } else {
      return res.status(400).json({ error: '不支持的模型渠道' });
    }

    if (!recognizedText || !recognizedText.trim()) {
      return res.json({ text: '> ⚠️ **系统提示：当前图片未检测到任何可识别的文本，或遇到异常无法解析。**' });
    }

    const responsePayload = { text: recognizedText };
    if (channel === 'silicon' && apiName === 'PaddlePaddle/PaddleOCR-VL-1.5' && routerLabel) {
      responsePayload.routerResult = routerLabel;
    }
    res.json(responsePayload);

  } catch (error) {
    console.error('识别失败:', error.message);
    res.status(500).json({ error: `${error.message}` });
  }
}
