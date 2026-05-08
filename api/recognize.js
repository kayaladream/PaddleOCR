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
    // 渠道二：硅基流动 (SiliconFlow)  — 仅方案二测试
    // ============================================
    else if (channel === 'silicon') {
      const url = 'https://api.siliconflow.cn/v1/chat/completions';
      
      const MODEL_CONFIGS = {
        'deepseek-ai/DeepSeek-OCR': {
          userText: '<image>\n<|grounding|>Convert the document to markdown.',
          temperature: 0.0,
          top_p: 1.0
          // DeepSeek 不需要额外坐标控制
        },
        'PaddlePaddle/PaddleOCR-VL-1.5': {
          userText: ' ',
          temperature: 0.0,
          top_p: 1.0,
          // ★ 方案二：尝试通过额外参数关闭坐标输出
          extra_params: {
            ignore_rc: true,         // 推测参数：忽略区域坐标
            return_ocr_info: false   // 推测参数：不返回OCR细节
          }
        }
      };

      const config = MODEL_CONFIGS[apiName] || {
        userText: '',
        temperature: 0.0,
        top_p: 1.0
      };

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

      // 构建请求体，将可能的额外参数展开
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
        max_tokens: 4096,
        ...(config.extra_params || {})  // 仅当配置中存在 extra_params 时才加入
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

      // ★ 测试阶段：完全不进行后处理清洗，直接返回原始结果
      // 如果坐标标记仍然存在，说明方案二的参数无效，需要启用方案一（正则清洗）
    } 
    else {
      return res.status(400).json({ error: '不支持的模型渠道' });
    }

    // ============================================
    // 最终返回
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
