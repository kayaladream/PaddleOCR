// api/recognize.js
// 将 PaddleOCR 的 OTSL 格式翻译为标准 HTML 表格，并具备“抗幻觉”能力
function parseOtslToHtml(text) {
  // 1. 【核心抗发疯补丁】：利用正则折叠无意义的死循环复读
  // 匹配任何长度在 1 到 50 个字符之间的片段，如果连续重复出现 3 次以上，则强制折叠为 1 次
  // 例如把 "公司公司公司公司" 变回 "公司"，"告 告 告" 变回 "告 "
  let cleanedText = text.replace(/(.{1,50}?)\1{3,}/g, '$1');

  if (!cleanedText.includes('<nl>') && !cleanedText.includes('<fcel>')) {
    return cleanedText;
  }

  try {
    let html = '<table class="markdown-table" style="border-collapse: collapse;" border="1"><tbody>\n';
    
    // 按行切分
    const rows = cleanedText.split('<nl>').filter(r => r.trim() !== '');

    rows.forEach(row => {
      html += '  <tr>\n';
      // 按照新单元格(<fcel>)或占位符(<ucel>、<xcel>)切割列
      const cells = row.split(/(?=<fcel>|<ucel>|<xcel>)/).filter(c => c.trim() !== '');

      cells.forEach(cell => {
        const colspan = 1 + (cell.match(/<lcel>/g) ||[]).length;
        const rowspan = 1 + (cell.match(/<ucel>/g) ||[]).length;
        
        // 提取真正的文字内容，同时清除所有的指令符号（新增 <xcel> 清除）
        const cellText = cell.replace(/<fcel>|<lcel>|<ucel>|<ecel>|<xcel>/g, '').trim();

        // 占位符跳过渲染
        if (cellText === '' && !cell.includes('<fcel>')) {
          return;
        }

        // 拼接带有合并属性的标准 HTML 标签
        let attrs =[];
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
    return text; // 如果解析失败，安全回退到原文本
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
      apiName
    } = req.body;

    if (!imageData || !mimeType) {
      return res.status(400).json({ error: '缺少 imageData 或 mimeType 参数' });
    }

    let recognizedText = '';

    // ============================================
    // 渠道一：Aistudio Baidu（保持原样）
    // ============================================
    if (channel === 'baidu') {
      let host;
      if (modelId === 'baidu-vl-1.5') {
        host = process.env.PADDLE_OCR_HOST_VL;
      } else if (modelId === 'baidu-ocrv5') {
        host = process.env.PADDLE_OCR_HOST_OCR;
      } else if (modelId === 'baidu-structurev3') {
        host = process.env.PADDLE_OCR_HOST_STRUCTURE;
      } else {
        host = process.env.PADDLE_OCR_HOST_VL;
      }

      if (!host) {
        throw new Error(`环境变量未设置：请配置 ${modelId === 'baidu-ocrv5' ? 'PADDLE_OCR_HOST_OCR' : modelId === 'baidu-structurev3' ? 'PADDLE_OCR_HOST_STRUCTURE' : 'PADDLE_OCR_HOST_VL'} 以及 PADDLE_TOKEN`);
      }

      let url = '';
      let payload = { file: imageData, fileType: 1 };

      if (modelId === 'baidu-vl-1.5') {
        url = `${host}/layout-parsing`;
        payload = { ...payload, useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false };
      } else if (modelId === 'baidu-ocrv5') {
        url = `${host}/ocr`;
        payload = { ...payload, useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false };
      } else if (modelId === 'baidu-structurev3') {
        url = `${host}/layout-parsing`;
        payload = { ...payload, useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false, useChartRecognition: false };
      } else {
        url = `${host}/layout-parsing`;
        payload = { ...payload, useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `token ${process.env.PADDLE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`百度 PaddleOCR 返回状态码 ${response.status}`);
      }

      const data = await response.json();

      if (modelId === 'baidu-ocrv5') {
        recognizedText = data?.result?.ocrResults?.map(res => res.prunedResult).join('\n\n') || '';
      } else {
        recognizedText = data?.result?.layoutParsingResults?.[0]?.markdown?.text || '';
      }
    }

    // ============================================
    // 渠道二：硅基流动 (SiliconFlow) —— 通用 OCR
    // ============================================
    else if (channel === 'silicon') {
      const url = 'https://api.siliconflow.cn/v1/chat/completions';

      // 对 PaddleOCR-VL 固定使用通用文本识别指令
      const MODEL_CONFIGS = {
        'PaddlePaddle/PaddleOCR-VL-1.5': {
          userText: 'Table Recognition:',
          temperature: 0.0,
          top_p: 1.0,
          frequency_penalty: 0.2,
          presence_penalty: 0.1,
        },
        'deepseek-ai/DeepSeek-OCR': {
          userText: '<image>\n<|grounding|>Convert the document to markdown.',
          temperature: 0.0,
          top_p: 1.0,
          frequency_penalty: 0.0,
          presence_penalty: 0.0,
        },
      };

      const config = MODEL_CONFIGS[apiName] || {
        userText: '<image>\nFree OCR.',
        temperature: 0.0,
        top_p: 1.0,
        frequency_penalty: 0.2,
        presence_penalty: 0.1,
      };

      const content = [
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${imageData}` },
        },
      ];

      if (config.userText && config.userText.trim() !== '') {
        content.push({
          type: 'text',
          text: config.userText,
        });
      }

      const payload = {
        model: apiName,
        messages: [{ role: 'user', content }],
        max_tokens: 4096,
      };

      if (config.temperature !== undefined) payload.temperature = config.temperature;
      if (config.top_p !== undefined) payload.top_p = config.top_p;
      if (config.frequency_penalty !== undefined) payload.frequency_penalty = config.frequency_penalty;
      if (config.presence_penalty !== undefined) payload.presence_penalty = config.presence_penalty;

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
        // 🚀 【新增】：先用翻译器把表格标签转成 HTML
        rawText = parseOtslToHtml(rawText);

        // 统一的清洗逻辑（保留原样不变）
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

    res.json({ text: recognizedText });

  } catch (error) {
    console.error('识别失败:', error.message);
    res.status(500).json({ error: `${error.message}` });
  }
}
