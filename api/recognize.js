// api/recognize.js
// 将 PaddleOCR 的 OTSL 格式翻译为标准 HTML 表格
function parseOtslToHtml(text) {
  // 如果没有表格特征符号，直接返回原文本
  if (!text.includes('<nl>') && !text.includes('<fcel>')) {
    return text;
  }

  try {
    let html = '<table class="markdown-table" style="border-collapse: collapse;" border="1"><tbody>\n';
    
    // 1. 按行切分
    const rows = text.split('<nl>').filter(r => r.trim() !== '');

    rows.forEach(row => {
      html += '  <tr>\n';
      // 2. 按照新单元格(<fcel>)或占位符(<ucel>)切割列
      const cells = row.split(/(?=<fcel>|<ucel>)/).filter(c => c.trim() !== '');

      cells.forEach(cell => {
        // 计算跨列 (lcel) 和跨行 (ucel)
        const colspan = 1 + (cell.match(/<lcel>/g) ||[]).length;
        const rowspan = 1 + (cell.match(/<ucel>/g) ||[]).length;
        
        // 提取真正的文字内容
        const cellText = cell.replace(/<fcel>|<lcel>|<ucel>|<ecel>/g, '').trim();

        // 核心逻辑：如果它是被上方合并的虚无占位符，在 HTML 中不需要渲染 td，直接跳过
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
async function autoDetectPrompt(imageData, mimeType, token) {
  try {
    const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // 推荐使用阿里 Qwen 视觉小模型作为“分类器”，速度极快，且通常在硅基流动是免费的
        model: 'Qwen/Qwen3-VL-32B-Instruct', 
        messages:[{
          role: 'user',
          content:[
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } },
            { 
              type: 'text', 
              text: '请判断这张图片的主要核心内容属于哪一类：\nA. 纯文字\nB. 表格\nC. 数学公式\n你只能输出一个大写字母，不要包含任何标点符号和多余废话。' 
            }
          ]
        }],
        max_tokens: 5,     // 只需要它输出一个字母，所以最大token设极小
        temperature: 0.1,  // 极低的温度保证确定的分类
      }),
    });
    
    if (!response.ok) return 'OCR:'; // 如果分类失败，降级为默认文本

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content?.trim().toUpperCase() || 'A';
    
    // 根据 AI 的回答，动态映射 PaddleOCR 官方指令
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
    return 'ERROR:'; // 修改：返回特殊标记，便于生成错误标签
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
    let routerLabel = null; // 新增：前端展示的路由标签

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
    // 渠道二：硅基流动 (SiliconFlow) —— 优化后
    // ============================================
    else if (channel === 'silicon') {
      const url = 'https://api.siliconflow.cn/v1/chat/completions';

      // 获取动态或者静态的配置
      let config = {};

      if (apiName === 'deepseek-ai/DeepSeek-OCR') {
        // DeepSeek 足够强大，一条指令走天下
        config = {
          userText: '<image>\n<|grounding|>Convert the document to markdown.',
          temperature: 0.0,
          top_p: 1.0,
          frequency_penalty: 0.0,
          presence_penalty: 0.0,
        };
      } else if (apiName === 'PaddlePaddle/PaddleOCR-VL-1.5') {
        // 🚀 【核心新增】使用路由函数，动态获取当前图片的最佳指令
        const dynamicPrompt = await autoDetectPrompt(imageData, mimeType, process.env.SILICON_TOKEN);
        
        // 生成供前端展示的路由标签
        if (dynamicPrompt === 'ERROR:') {
          routerLabel = '路由分类请求出错';
        } else if (dynamicPrompt?.includes('Table')) {
          routerLabel = '表格';
        } else if (dynamicPrompt?.includes('Formula')) {
          routerLabel = '公式';
        } else if (dynamicPrompt?.includes('OCR:')) {
          routerLabel = '纯文本';
        }

        config = {
          userText: dynamicPrompt, // 此时它可能是 OCR: 或 Table Recognition: 或 Formula Recognition:
          temperature: 0.0,
          top_p: 1.0,
          // 仍然保留微小惩罚，打断小模型的复读
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

      const content =[
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${imageData}` },
        },
      ];

      // DeepSeek 格式的 prompt (放在 text 中) / PaddleOCR 的 prompt (如果是 OCR: 直接拼接，这里用 text)
      if (config.userText && config.userText.trim() !== '') {
        content.push({ type: 'text', text: config.userText });
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

    // 修改：仅当 PaddleOCR 时附带路由检测结果
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
