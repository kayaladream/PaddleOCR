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

    // 仅分类模式
    if (classifyOnly && channel === 'silicon' && apiName === 'PaddlePaddle/PaddleOCR-VL-1.6') {
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
    // 渠道一：Aistudio Baidu (最新异步接口)
    // ============================================
    if (channel === 'baidu') {
      if (!process.env.PADDLE_TOKEN) {
        throw new Error('环境变量未设置：请配置 PADDLE_TOKEN');
      }

      const JOB_URL = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs';
      
      let actualModelName = 'PaddleOCR-VL-1.6';
      let optionalPayload = {};

      if (modelId === 'baidu-vl-1.6') {
        actualModelName = 'PaddleOCR-VL-1.6';
        optionalPayload = { useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false };
      } else if (modelId === 'baidu-ocr') {
        actualModelName = 'PP-OCRv6';
        optionalPayload = { useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false };
      } else if (modelId === 'baidu-structurev3') {
        actualModelName = 'PP-StructureV3';
        optionalPayload = { useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false };
      } else {
        actualModelName = 'PaddleOCR-VL-1.6';
        optionalPayload = { useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false };
      }

      // 1. 将 base64 转为 Blob 用于 FormData 文件上传
      const buffer = Buffer.from(imageData, 'base64');
      const blob = new Blob([buffer], { type: mimeType || 'image/jpeg' });
      const ext = mimeType?.split('/')[1] || 'jpg';

      const formData = new FormData();
      formData.append('model', actualModelName);
      formData.append('optionalPayload', JSON.stringify(optionalPayload));
      formData.append('file', blob, `image.${ext}`); // 必须指定文件名让后端识别

      // 2. 提交任务
      const jobResponse = await fetch(JOB_URL, {
        method: 'POST',
        headers: {
          'Authorization': `bearer ${process.env.PADDLE_TOKEN}`
          // 注意：不要手动设置 Content-Type，fetch会自动处理包含 boundary 的 multipart/form-data 头
        },
        body: formData,
      });

      if (!jobResponse.ok) {
        const errText = await jobResponse.text();
        throw new Error(`百度任务提交失败，状态码 ${jobResponse.status}: ${errText}`);
      }

      const jobData = await jobResponse.json();
      const jobId = jobData?.data?.jobId;
      if (!jobId) {
        throw new Error('百度接口未返回 jobId，请检查账号 Token 或服务状态');
      }

      // 3. 轮询结果 (每次等待3秒，最多尝试40次约等于120秒，匹配前端超时)
      let jsonlUrl = '';
      const maxRetries = 40; 
      let attempts = 0;

      while (attempts < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        attempts++;

        const pollResponse = await fetch(`${JOB_URL}/${jobId}`, {
          headers: {
            'Authorization': `bearer ${process.env.PADDLE_TOKEN}`
          }
        });

        // 容忍偶发的网络抖动
        if (!pollResponse.ok) continue;

        const pollData = await pollResponse.json();
        const state = pollData?.data?.state;

        if (state === 'done') {
          jsonlUrl = pollData?.data?.resultUrl?.jsonUrl;
          break;
        } else if (state === 'failed') {
          throw new Error(`百度 OCR 任务执行失败: ${pollData?.data?.errorMsg}`);
        }
      }

      if (!jsonlUrl) {
        throw new Error('轮询超时，未能获取百度识别结果');
      }

      // 4. 下载并解析 JSONL 结果文件
      const jsonlResponse = await fetch(jsonlUrl);
      if (!jsonlResponse.ok) {
        throw new Error(`获取结果文件失败，状态码 ${jsonlResponse.status}`);
      }
      
      const jsonlText = await jsonlResponse.text();
      const lines = jsonlText.trim().split('\n').filter(Boolean);
      
      // 因为每次发单张图，所以提取第一行即可
      if (lines.length > 0) {
        const resultObj = JSON.parse(lines[0])?.result || {};
        
        if (modelId === 'baidu-ocrv6') {
          // 延续你原来提取纯文本的逻辑
          recognizedText = resultObj?.ocrResults
            ?.flatMap(res => res.prunedResult?.rec_texts || [])
            .filter(Boolean)
            .join('\n') || '';
        } else {
          // 提取 Markdown 格式的逻辑
          recognizedText = resultObj?.layoutParsingResults?.[0]?.markdown?.text || '';
        }
      } else {
        recognizedText = '';
      }
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
      } else if (apiName === 'PaddlePaddle/PaddleOCR-VL-1.6') {
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

        // ===== DeepSeek-OCR 专有后处理：智能清洗 + 空白检测 =====
        if (apiName === 'deepseek-ai/DeepSeek-OCR') {
          console.log('DeepSeek rawText (after parse):', rawText.substring(0, 200));

          // 1. 判断是否存在典型的空白/乱码特征（大量重复数字点号）
          const looksLikeNoise = /(\d\.){5,}\d/.test(rawText) ||
                                 /^[\d.#\s]+$/.test(rawText.trim());

          // 2. 只有存在乱码特征时，才清理孤立的 "text" 噪声
          if (looksLikeNoise) {
            // 删除单独成行的 "text"（大小写不限）
            rawText = rawText.replace(/^\s*text\s*$/gim, '');
            // 删除被空白包围的独立 "text" 单词
            rawText = rawText.replace(/\btext\b/gi, (match, offset, str) => {
              const before = offset === 0 ? '' : str[offset - 1];
              const after = offset + match.length >= str.length ? '' : str[offset + match.length];
              return (/[\s\n]/.test(before) && /[\s\n]/.test(after)) ? '' : match;
            });
          }

          // 3. 压缩多余空行
          rawText = rawText.replace(/\n{3,}/g, '\n\n');

          // 4. 空白图片检测（即使没有乱码特征，也可能完全为空）
          let cleaned = rawText.replace(/\[\[.*?\]\]/g, '');
          cleaned = cleaned.replace(/<\|[^>]*\|>/g, '');
          cleaned = cleaned.replace(/[\d.#\s\-–—_\/\\\(\)\[\]\*=\+,|]/g, '');
          cleaned = cleaned.replace(/^[\s]*text[\s]*$/gim, '');
          const hasMeaningfulChar = /[a-zA-Z\u4e00-\u9fa5]/.test(cleaned);
          if (!cleaned.trim() || !hasMeaningfulChar) {
            console.log('DeepSeek 检测到空白图片或无效乱码，清空结果');
            rawText = '';
          }
        }

        // 原有的通用清洗逻辑（所有模型均适用，包括 DeepSeek）
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
    if (channel === 'silicon' && apiName === 'PaddlePaddle/PaddleOCR-VL-1.6' && routerLabel) {
      responsePayload.routerResult = routerLabel;
    }
    res.json(responsePayload);

  } catch (error) {
    console.error('识别失败:', error.message);
    res.status(500).json({ error: `${error.message}` });
  }
}
