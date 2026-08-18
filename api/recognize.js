// api/recognize.js
export const maxDuration = 330; // 防止 Vercel 免费版过早超时断开

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
      return 'Table Recognition:';
    }
    if (reply.includes('C')) {
      return 'Formula Recognition:';
    }
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
      modelId = 'baidu-vl-1.6',
      channel = 'baidu',
      apiName,
      classifyOnly = false
    } = req.body;

    if (!imageData || !mimeType) {
      return res.status(400).json({ error: '缺少 imageData 或 mimeType 参数' });
    }

    let recognizedText = '';
    let routerLabel = null;

    // 仅分类模式 (硅基流动使用)
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
    // 渠道一：Aistudio Baidu (适配官方最新 V2 异步接口)
    // ============================================
    if (channel === 'baidu') {
      if (!process.env.PADDLE_TOKEN) {
        throw new Error('环境变量未设置：请配置 PADDLE_TOKEN');
      }

      const JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
      
      // 匹配新的模型名称
      let actualModelName = "PaddleOCR-VL-1.6";
      if (modelId === 'baidu-ocrv6' || modelId === 'baidu-ocrv5') {
        actualModelName = "PP-OCRv6";
      } else if (modelId === 'baidu-structurev3') {
        actualModelName = "PP-StructureV3";
      }

      // 构建请求 payload
      const optionalPayload = {
        useDocOrientationClassify: false,
        useDocUnwarping: false,
        useChartRecognition: false,
        useTextlineOrientation: false
      };

      const formData = new FormData();
      formData.append('model', actualModelName);
      formData.append('optionalPayload', JSON.stringify(optionalPayload));
      
      // 将 Base64 转为 Blob 追加进 FormData
      const buffer = Buffer.from(imageData, 'base64');
      const blob = new Blob([buffer], { type: mimeType });
      // 附带扩展名伪装成真实文件
      formData.append('file', blob, mimeType === 'image/png' ? 'image.png' : 'image.jpg');

      // 1. 提交 Job
      const jobResponse = await fetch(JOB_URL, {
        method: 'POST',
        headers: {
          'Authorization': `bearer ${process.env.PADDLE_TOKEN}`
          // FormData fetch时切忌手动设置 Content-Type，由于boundary的原因会自动生成
        },
        body: formData,
      });

      if (!jobResponse.ok) {
        const errorText = await jobResponse.text();
        throw new Error(`百度 PaddleOCR 创建任务失败，状态码 ${jobResponse.status}: ${errorText}`);
      }

      const jobData = await jobResponse.json();
      const jobId = jobData?.data?.jobId;
      if (!jobId) throw new Error("无法获取到任务 jobId");

      // 2. 轮询结果
      let finalJsonlUrl = "";
      const MAX_POLLING_ATTEMPTS = 25; // 最多轮询 25 次 (约 50 秒)，Vercel 有限制不能太久

      for (let i = 0; i < MAX_POLLING_ATTEMPTS; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 每次轮询间隔2秒

        const pollResponse = await fetch(`${JOB_URL}/${jobId}`, {
          method: 'GET',
          headers: { 'Authorization': `bearer ${process.env.PADDLE_TOKEN}` }
        });

        if (!pollResponse.ok) throw new Error("获取任务状态失败");
        const pollResult = await pollResponse.json();
        const state = pollResult?.data?.state;

        if (state === 'done') {
          finalJsonlUrl = pollResult?.data?.resultUrl?.jsonUrl;
          break;
        } else if (state === 'failed') {
          throw new Error(`识别任务失败: ${pollResult?.data?.errorMsg}`);
        }
        // 如果是 'pending' 或 'running' 则继续循环
      }

      if (!finalJsonlUrl) {
        throw new Error("任务超时未能完成，请稍后再试");
      }

      // 3. 拉取并解析 jsonl 结果文件
      const jsonlResponse = await fetch(finalJsonlUrl);
      if (!jsonlResponse.ok) throw new Error("无法获取解析结果文件");
      
      const jsonlText = await jsonlResponse.text();
      const lines = jsonlText.split('\n').filter(line => line.trim() !== '');
      let fullParsedText = [];

      lines.forEach(line => {
        try {
          const parsed = JSON.parse(line);
          const resultObj = parsed?.result || {};

          // 如果是超轻量文本识别模型 PP-OCRv6
          if (actualModelName === 'PP-OCRv6' && resultObj.ocrResults) {
             const pageTexts = resultObj.ocrResults
               .flatMap(res => res.prunedResult?.rec_texts || [])
               .filter(Boolean);
             if (pageTexts.length > 0) fullParsedText.push(pageTexts.join('\n'));
          } 
          // 如果是布局解析模型 (VL-1.6 / StructureV3)
          else if (resultObj.layoutParsingResults) {
             const pageTexts = resultObj.layoutParsingResults
               .map(res => res?.markdown?.text || '')
               .filter(Boolean);
             if (pageTexts.length > 0) fullParsedText.push(pageTexts.join('\n\n'));
          }
        } catch (e) {
          console.error("行数据解析错误: ", e);
        }
      });

      recognizedText = fullParsedText.join('\n\n');
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
