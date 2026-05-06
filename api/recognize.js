// api/recognize.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '仅支持POST请求' });
  }

  try {
    const { imageData, mimeType } = req.body;
    if (!imageData || !mimeType) {
      return res.status(400).json({ error: '缺少imageData或mimeType参数' });
    }

    // 调用 PaddleOCR API
    const response = await fetch('https://ra96v0pbs0jdt3z6.aistudio-app.com/layout-parsing', {
      method: 'POST',
      headers: {
        'Authorization': `token ${process.env.PADDLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file: imageData,
        fileType: 1,      // 1=图片
        useDocOrientationClassify: false,
        useDocUnwarping: false,
        useChartRecognition: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`PaddleOCR 返回状态码 ${response.status}`);
    }

    const data = await response.json();
    const markdownText = data?.result?.layoutParsingResults?.[0]?.markdown?.text || '';

    if (!markdownText.trim()) {
      return res.json({ text: '> ⚠️ **系统提示：当前图片未检测到任何可识别的文本。**' });
    }

    // 返回完整 Markdown 文本
    res.json({ text: markdownText });
  } catch (error) {
    console.error('识别失败:', error.message);
    res.status(500).json({ error: `识别失败: ${error.message}` });
  }
}