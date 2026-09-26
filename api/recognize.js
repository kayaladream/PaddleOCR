// api/recognize.js

// ===== 带超时控制的 fetch =====
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 5000, ...fetchOptions } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, { ...fetchOptions, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    if (error.name === 'AbortError') {
      throw new Error(`请求超时 (${timeout}ms)`);
    }
    throw error;
  }
}

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
    const response = await fetchWithTimeout('https://api.siliconflow.cn/v1/chat/completions', {
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
      timeout: 10000,
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
    console.error('路由分类请求出错:', error.message);
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
      } else if (modelId === 'baidu-ocrv6') {
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
      formData.append('file', blob, `image.${ext}`);

      // 2. 提交任务（带超时机制 + 代理回退）
      let jobResponse = null;
      const directUrl = JOB_URL;
      const proxyUrl = `${process.env.PROXY_URL}/${encodeURIComponent(JOB_URL)}`;

      try {
        // 第一次尝试：直连百度（5秒超时，快速失败）
        console.log(`[网络检测] 正在尝试直连百度提交任务（超时5秒）...`);
        jobResponse = await fetchWithTimeout(directUrl, {
          method: 'POST',
          headers: { 'Authorization': `bearer ${process.env.PADDLE_TOKEN}` },
          body: formData,
          timeout: 5000, 
        });
        if (jobResponse.ok) {
          console.log(`✅ [网络检测] 直连百度提交任务成功！`);
        } else {
          console.log(`⚠️ [网络检测] 直连百度返回非200 (状态码: ${jobResponse.status})，尝试通过阿里云代理...`);
          jobResponse = null; // 置空，触发代理逻辑
        }
      } catch (directError) {
        console.log(`⚠️ [网络检测] 直连百度失败 (${directError.message})，正在通过阿里云代理提交...`);
        jobResponse = null;
      }

      // 如果直连失败，走代理
      if (!jobResponse) {
        try {
          jobResponse = await fetchWithTimeout(proxyUrl, {
            method: 'POST',
            headers: { 'Authorization': `bearer ${process.env.PADDLE_TOKEN}` },
            body: formData,
            timeout: 20000, // 代理提交给20秒
          });
          if (jobResponse.ok) {
            console.log(`✅ [网络检测] 阿里云代理提交成功！`);
          } else {
            console.log(`❌ [网络检测] 阿里云代理提交失败，状态码: ${jobResponse.status}`);
          }
        } catch (proxyError) {
          console.error(`❌ [网络检测] 阿里云代理也连接超时，彻底失败: ${proxyError.message}`);
          throw proxyError;
        }
      }

      if (!jobResponse || !jobResponse.ok) {
        const errText = jobResponse ? await jobResponse.text() : '无响应';
        throw new Error(`百度任务提交失败，状态码 ${jobResponse ? jobResponse.status : '未知'}: ${errText}`);
      }

      const jobData = await jobResponse.json();
      const jobId = jobData?.data?.jobId;
      if (!jobId) {
        throw new Error('百度接口未返回 jobId，请检查账号 Token 或服务状态');
      }

      // 3. 轮询结果 (每次等待3秒，最多尝试40次约等于120秒)
      let jsonlUrl = '';
      const maxRetries = 40; 
      let attempts = 0;

      while (attempts < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        attempts++;

        let pollResponse = null;
        const pollUrl = `${JOB_URL}/${jobId}`;
        const proxyPollUrl = `${process.env.PROXY_URL}/${encodeURIComponent(pollUrl)}`;

        try {
          // 第一次尝试：直连百度（5秒超时）
          pollResponse = await fetchWithTimeout(pollUrl, {
            headers: { 'Authorization': `bearer ${process.env.PADDLE_TOKEN}` },
            timeout: 5000,
          });
        } catch (directError) {
          console.log(`[网络检测] 轮询直连失败，尝试通过阿里云代理 (第 ${attempts} 次)...`);
          try {
            // 第二次尝试：通过阿里云代理（10秒超时）
            pollResponse = await fetchWithTimeout(proxyPollUrl, {
              headers: { 'Authorization': `bearer ${process.env.PADDLE_TOKEN}` },
              timeout: 10000,
            });
          } catch (proxyError) {
            console.log(`[网络检测] 轮询代理也失败 (第 ${attempts} 次)，等待下轮重试: ${proxyError.message}`);
            continue; // 网络波动，继续下一次循环
          }
        }

        // 容忍偶发的网络抖动
        if (!pollResponse || !pollResponse.ok) {
            console.log(`[轮询状态] 第 ${attempts} 次轮询返回状态码: ${pollResponse ? pollResponse.status : '未知'}`);
            continue;
        }

        const pollData = await pollResponse.json();
        const state = pollData?.data?.state;
        console.log(`[轮询状态] 第 ${attempts} 次轮询，当前任务状态: ${state}`);

        if (state === 'done') {
          jsonlUrl = pollData?.data?.resultUrl?.jsonUrl;
          console.log(`✅ [任务完成] 成功获取结果URL！`);
          break;
        } else if (state === 'failed') {
          throw new Error(`百度 OCR 任务执行失败: ${pollData?.data?.errorMsg}`);
        }
      }

      if (!jsonlUrl) {
        throw new Error('轮询超时，未能获取百度识别结果');
      }

      // 4. 下载并解析 JSONL 结果文件
      // ⚠️ 修改点：百度 BOS 在海外极大概率无法直连，直接强制走代理，并设置 15 秒超时
      let jsonlResponse;
      const proxyJsonlUrl = `${process.env.PROXY_URL}/${encodeURIComponent(jsonlUrl)}`;

      try {
        console.log(`[网络检测] 正在通过阿里云代理下载结果文件（超时15秒）...`);
        jsonlResponse = await fetchWithTimeout(proxyJsonlUrl, {
          timeout: 15000,
        });
        if (jsonlResponse && jsonlResponse.ok) {
          console.log(`✅ [网络检测] 代理下载结果成功！`);
        } else {
          console.log(`❌ [网络检测] 代理下载结果失败，状态码: ${jsonlResponse ? jsonlResponse.status : '未知'}`);
        }
      } catch (proxyError) {
        throw new Error(`下载结果文件代理也失败: ${proxyError.message}`);
      }

      if (!jsonlResponse || !jsonlResponse.ok) {
        throw new Error(`获取结果文件失败，状态码 ${jsonlResponse ? jsonlResponse.status : '未知'}`);
      }
      
      const jsonlText = await jsonlResponse.text();
      const lines = jsonlText.trim().split('\n').filter(Boolean);
      
      // 因为每次发单张图，所以提取第一行即可
      if (lines.length > 0) {
        const resultObj = JSON.parse(lines[0])?.result || {};
        
        if (modelId === 'baidu-ocrv6' || modelId === 'baidu-ocrv5') {
          // 提取纯文本的逻辑
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

      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SILICON_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        timeout: 120000, // 硅基流动大模型识别可能需要较长时间，给2分钟
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`硅基流动 API 返回状态码 ${response.status} - ${errText}`);
      }

      const data = await response.json();
      let rawText = data?.choices?.[0]?.message?.content || '';

      if (rawText) {
        rawText = parseOtslToHtml(rawText);

        // ===== DeepSeek-OCR 专有后处理 =====
        if (apiName === 'deepseek-ai/DeepSeek-OCR') {
          console.log('DeepSeek rawText (after parse):', rawText.substring(0, 200));
          const looksLikeNoise = /(\d\.){5,}\d/.test(rawText) || /^[\d.#\s]+$/.test(rawText.trim());
          if (looksLikeNoise) {
            rawText = rawText.replace(/^\s*text\s*$/gim, '');
            rawText = rawText.replace(/\btext\b/gi, (match, offset, str) => {
              const before = offset === 0 ? '' : str[offset - 1];
              const after = offset + match.length >= str.length ? '' : str[offset + match.length];
              return (/[\s\n]/.test(before) && /[\s\n]/.test(after)) ? '' : match;
            });
          }
          rawText = rawText.replace(/\n{3,}/g, '\n\n');
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

        // 通用清洗逻辑
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
    console.error('识别失败:', error);
    console.error('错误消息:', error.message);

    if (error.cause) {
      console.error('底层原因 error.cause:', error.cause);
    }

    // ⚠️ 这里提取为变量，彻底杜绝括号嵌套导致的 SyntaxError
    const errorPayload = {
      error: error.message || '未知错误'
    };

    if (error.cause) {
      errorPayload.cause = {
        code: error.cause.code,
        message: error.cause.message,
        errno: error.cause.errno,
        syscall: error.cause.syscall,
        hostname: error.cause.hostname,
      };
    }

    res.status(500).json(errorPayload);
  }
}
