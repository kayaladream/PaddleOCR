// api/recognize.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '仅支持POST请求' });
  }

  try {
    const { imageData, mimeType, modelId = 'baidu-vl-1.5', channel = 'baidu', apiName } = req.body;
    
    if (!imageData || !mimeType) {
      return res.status(400).json({ error: '缺少 imageData 或 mimeType 参数' });
    }

    let recognizedText = '';

    // ============================================
    // 渠道一：Aistudio Baidu 
    // ============================================
    if (channel === 'baidu') {
      // 根据模型读取对应的环境变量，不提供任何硬编码默认值
      let host;
      if (modelId === 'baidu-vl-1.5') {
        host = process.env.PADDLE_OCR_HOST_VL;
      } else if (modelId === 'baidu-ocrv5') {
        host = process.env.PADDLE_OCR_HOST_OCR;
      } else if (modelId === 'baidu-structurev3') {
        host = process.env.PADDLE_OCR_HOST_STRUCTURE;
      } else {
        // 未知模型使用 VL 地址作为兜底
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
    // 渠道二：硅基流动 (SiliconFlow)
    // ============================================
    else if (channel === 'silicon') {
      const url = 'https://api.siliconflow.cn/v1/chat/completions';
      
      const MODEL_CONFIGS = {
        'deepseek-ai/DeepSeek-OCR': {
          userText: '<image>\nConvert the document to markdown.',
          temperature: 0.0,
          top_p: 1.0,
          frequency_penalty: 0.0
        },
        'PaddlePaddle/PaddleOCR-VL-1.5': {
          // 必须传入显式的指令，即使是尝试让它做全图识别
          userText: '<image>\n请将图片中的文档内容转换为 Markdown 格式。\n要求：\n- 保留表格，使用 Markdown 表格语法输出\n- 保留公式，使用 LaTeX 语法包裹\n- 不要输出坐标标记，只输出最终 Markdown', 
          temperature: 0.0, // OCR 任务必须降低到 0.0 保证确定性
          top_p: 1.0,
          frequency_penalty: 0.0 // 绝对不能开频率惩罚！
        }
      };

      const config = MODEL_CONFIGS[apiName] || {
        userText: '',
        temperature: 0.0,
        top_p: 1.0,
        frequency_penalty: 0.0
      };

      const content =[
        { 
          type: "image_url", 
          image_url: { url: `data:${mimeType};base64,${imageData}` } 
        }
      ];

      if (config.userText && config.userText.trim() !== '') {
        content.push({ 
          type: "text", 
          text: config.userText 
        });
      }

      const payload = {
        model: apiName,
        messages:[
          {
            role: "user",
            content: content
          }
        ],
        temperature: config.temperature,
        top_p: config.top_p,
        frequency_penalty: config.frequency_penalty, // 传入频率惩罚参数
        max_tokens: 4096
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

      // 清洗坐标标记及多余空行（所有模型通用）
      if (rawText) {
        rawText = rawText.replace(/^.*<\|ref\|>.*<\/\|ref\|>.*$/gm, '');
        rawText = rawText.replace(/^.*<\|det\|>.*<\/\|det\|>.*$/gm, '');
        rawText = rawText.replace(/<\|?LOC[^>]*\|?>/g, '');
        rawText = rawText.replace(/<\|ref\|>/g, '').replace(/<\/\|ref\|>/g, '');
        rawText = rawText.replace(/<\|det\|>/g, '').replace(/<\/\|det\|>/g, '');
        rawText = rawText.replace(/\n{3,}/g, '\n\n');

        // “复读”陷阱只针对 PaddleOCR-VL-1.5 启用
        if (apiName === 'PaddlePaddle/PaddleOCR-VL-1.5') {
          // 防止跨行重复片段（5 字符以上重复 ≥5 次）
          rawText = rawText.replace(/(.{5,}?)\1{4,}/gs, '$1\n> *(内容重复，识别已截断)*\n');
          // 防止整行重复（长于 15 字符的行重复 ≥5 次，避免误伤表格结构行）
          rawText = rawText.replace(/(^[^\n]{15,}\n)\1{4,}/gm, (match) => {
            return match.split('\n')[0] + '\n> *(内容重复，识别已截断)*\n';
          });
        }

        recognizedText = rawText.trim();
      } else {
        recognizedText = '';
      }
    }
    else {
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
