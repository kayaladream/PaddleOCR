// api/recognize.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '仅支持POST请求' });
  }

  try {
    // 新增 promptType 参数，默认 ocr
    const {
      imageData,
      mimeType,
      modelId = 'baidu-vl-1.5',
      channel = 'baidu',
      apiName,
      promptType = 'ocr'   // 可选：ocr / table / formula / chart
    } = req.body;

    if (!imageData || !mimeType) {
      return res.status(400).json({ error: '缺少 imageData 或 mimeType 参数' });
    }

    let recognizedText = '';

    // ============================================
    // 渠道一：Aistudio Baidu
    // （未改动，保持原来逻辑）
    // ============================================
    if (channel === 'baidu') {
      // ... 百度渠道代码不变 ...
    }

    // ============================================
    // 渠道二：硅基流动 (SiliconFlow)
    // ============================================
    else if (channel === 'silicon') {
      const url = 'https://api.siliconflow.cn/v1/chat/completions';

      // 官方示例 Prompt（仅对 PaddleOCR-VL 有效）
      const PROMPTS = {
        ocr: 'OCR:',
        table: 'Table Recognition:',
        formula: 'Formula Recognition:',
        chart: 'Chart Recognition:',
      };

      // 针对具体模型的默认配置
      const MODEL_CONFIGS = {
        'deepseek-ai/DeepSeek-OCR': {
          userText: '<image>\n<|grounding|>Detailedly convert this table and formula into LaTeX/Markdown.',
          temperature: 0.0,
          top_p: 1.0,
          frequency_penalty: 0.6,
          presence_penalty: 0.3,
        },
        'PaddlePaddle/PaddleOCR-VL-1.5': {
          // 使用官方 promptMap 中对应的指令
          userText: PROMPTS[promptType] || PROMPTS.ocr,
          temperature: 0.0,
          top_p: 1.0,
          frequency_penalty: 0.6,
          presence_penalty: 0.3,
        },
      };

      const config = MODEL_CONFIGS[apiName] || {
        userText: '<image>\nFree OCR.',
        temperature: 0.0,
        top_p: 1.0,
        frequency_penalty: 0.2,
        presence_penalty: 0.1,
      };

      // 组装 content 数组
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

      // 仅传入有明确定义的参数
      if (config.temperature !== undefined) payload.temperature = config.temperature;
      if (config.top_p !== undefined) payload.top_p = config.top_p;
      if (config.frequency_penalty !== undefined) payload.frequency_penalty = config.frequency_penalty;
      if (config.presence_penalty !== undefined) payload.presence_penalty = config.presence_penalty;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.SILICON_TOKEN}`,
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

      // 原有的清洗逻辑（坐标、防复读等）
      if (rawText) {
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
