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
      let url = '';
      let payload = { file: imageData, fileType: 1 }; // 默认必须参数，1=图片

      // 根据具体模型分配 URL 和可选参数
      if (modelId === 'baidu-vl-1.5') {
        url = 'https://ra96v0pbs0jdt3z6.aistudio-app.com/layout-parsing';
        payload = { ...payload, useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false };
      } else if (modelId === 'baidu-ocrv5') {
        url = 'https://zf621chdy2w291t7.aistudio-app.com/ocr';
        payload = { ...payload, useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false };
      } else if (modelId === 'baidu-structurev3') {
        url = 'https://v6adbd7ek7geu03e.aistudio-app.com/layout-parsing';
        payload = { ...payload, useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false, useChartRecognition: false };
      } else {
        // 兜底默认使用 VL-1.5
        url = 'https://ra96v0pbs0jdt3z6.aistudio-app.com/layout-parsing';
        payload = { ...payload, useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false };
      }

      // 发送百度 API 请求
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
      
      // 根据返回结果结构解析文本
      if (modelId === 'baidu-ocrv5') {
        // ocrv5 是返回 ocrResults 列表，提取其 prunedResult
        recognizedText = data?.result?.ocrResults?.map(res => res.prunedResult).join('\n\n') || '';
      } else {
        // vl-1.5 和 structurev3 都是返回 layoutParsingResults 包含 markdown
        recognizedText = data?.result?.layoutParsingResults?.[0]?.markdown?.text || '';
      }
    } 
    // ============================================
    // 渠道二：硅基流动 (SiliconFlow)
    // ============================================
    else if (channel === 'silicon') {
      const url = 'https://api.siliconflow.cn/v1/chat/completions';
      
      // 使用 OpenAI 兼容的视觉模型 Payload 格式
      const payload = {
        model: apiName, // 例如 "PaddlePaddle/PaddleOCR-VL-1.5" 或 "deepseek-ai/DeepSeek-OCR"
        messages:[
          {
            role: "user",
            content:[
              { 
                type: "image_url", 
                image_url: { url: `data:${mimeType};base64,${imageData}` } 
              },
              { 
                type: "text", 
                text: "请提取并识别这张图片中的所有文字。如果是文档、排版或表格内容，请使用Markdown格式严格保留原始排版和结构。" 
              }
            ]
          }
        ]
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
      recognizedText = data?.choices?.[0]?.message?.content || '';
    } 
    else {
      return res.status(400).json({ error: '不支持的模型渠道' });
    }

    // ============================================
    // 最终处理并返回结果
    // ============================================
    if (!recognizedText || !recognizedText.trim()) {
      return res.json({ text: '> ⚠️ **系统提示：当前图片未检测到任何可识别的文本，或遇到异常无法解析。**' });
    }

    res.json({ text: recognizedText });

  } catch (error) {
    console.error('识别失败:', error.message);
    res.status(500).json({ error: `${error.message}` });
  }
}
