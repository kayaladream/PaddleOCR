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
      let payload = { file: imageData, fileType: 1 };

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
        url = 'https://ra96v0pbs0jdt3z6.aistudio-app.com/layout-parsing';
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
      
      // ====== 模型专属配置 ======
      const MODEL_CONFIGS = {
        'deepseek-ai/DeepSeek-OCR': {
          userText: '<image>\nConvert the document to markdown.',
          temperature: 0.0,
          top_p: 1.0
        },
        'PaddlePaddle/PaddleOCR-VL-1.5': {
          userText: ' ',
          temperature: 0.0,
          top_p: 1.0
        }
      };

      // 获取配置，未知模型使用安全兜底（空指令）
      const config = MODEL_CONFIGS[apiName] || {
        userText: '',
        temperature: 0.0,
        top_p: 1.0
      };

      // 动态构建 content
      const content = [
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
        messages: [
          {
            role: "user",
            content: content
          }
        ],
        temperature: config.temperature,
        top_p: config.top_p,
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

      // ====== 移除可能残留的坐标/定位标记 ======
      if (rawText) {
        // 1. 移除整行的 ref/det 标记行
        rawText = rawText.replace(/^.*<\|ref\|>.*<\/\|ref\|>.*$/gm, '');
        rawText = rawText.replace(/^.*<\|det\|>.*<\/\|det\|>.*$/gm, '');
        
        // 2. 移除所有 <LOC_数字> 标记
        rawText = rawText.replace(/<LOC_\d+>/g, '');
        
        // 3. 移除零散的 ref/det 标签
        rawText = rawText.replace(/<\|ref\|>/g, '').replace(/<\/\|ref\|>/g, '');
        rawText = rawText.replace(/<\|det\|>/g, '').replace(/<\/\|det\|>/g, '');
        
        // 4. 压缩连续空行（最多保留一个空行）
        rawText = rawText.replace(/\n{3,}/g, '\n\n');
        
        // 5. 去除首尾空白
        recognizedText = rawText.trim();
      } else {
        recognizedText = '';
      }
    } 
    else {
      return res.status(400).json({ error: '不支持的模型渠道' });
    }

    // ============================================
    // 最终校验并返回
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
