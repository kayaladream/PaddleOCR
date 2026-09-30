# 基于多渠道与智能路由的先进 OCR 系统
**(PaddleOCR / DeepSeek-OCR / Qwen3-VL 联合驱动)**

## 项目概述
本项目是一个全能型的多模态智能文字识别（OCR）与文档解析 Web 平台。依托 **百度 PaddleOCR 官方接口** 与 **硅基流动 (SiliconFlow)** 提供的顶尖模型，支持多语言、长文档、手写体、复杂表格及数学公式的超高精度提取，并可一键输出标准 Markdown 格式。

通过引入 `Qwen3-VL-32B-Instruct` 作为智能路由器，系统能够全自动判断图片类型（纯文本/表格/公式），从而匹配最精准的提示词（Prompt）与解析策略。

## 🌟 核心特性
- **多渠道 & 多模型支持**：
  - 🥇 **百度官方渠道**：PaddleOCR-VL-1.5, PP-OCRv5, PP-StructureV3 (原生异步高并发接口)。
  - 🚀 **硅基流动渠道**：DeepSeek-OCR, PaddleOCR-VL-1.5 (轻量、极速备用)。
- **🤖 智能路由分类**：基于 `Qwen3-VL` 自动分析图片场景（纯文本/表格/数学公式），智能分发处理策略。
- **📄 批量与 PDF 支持**：支持多图并发上传，支持 PDF 拖拽一键转码切图解析。
- **✨ 沉浸式交互**：打字机流式渐变动效，支持图片粘贴、拖拽、URL 远程拉取，自适应多端响应式布局。
- **✍️ 即时编辑与复制**：内置富文本 Markdown 编辑器，识别结果所见即所得，表格可直接复制粘贴至 Excel 保留格式。

## 💰 费用与限制说明 (重要)
本项目接入了多个第三方模型，收费情况如下：
1. **百度渠道 (PaddleOCR API)**：目前通过 AI Studio 获取的 Token 调用**完全免费**。
2. **硅基流动基础 OCR 模型**：DeepSeek-OCR 等基础视觉模型通常有免费额度或极低费率。
3. **⚠️ 智能路由模型收费**：系统中用于自动分类的 `Qwen/Qwen3-VL-32B-Instruct` 模型**在硅基流动平台是收费的**。
   - **实测成本**：每次智能分类消耗的 Token 极少，**折合每张图片约 0.001 元人民币**。
   - **注意事项**：如果你频繁使用“硅基流动版 PaddleOCR-VL-1.5”并开启了智能路由，请务必保证你的 SiliconFlow 账户内有足够余额（首次注册平台通常会赠送额度）。

## 📸 实际效果
<div align="center">
  <img width="1166" height="819" alt="手写稿识别" src="https://github.com/user-attachments/assets/5ea98001-2454-45b5-b956-5e573bbe64dd" />
  <br>
  <small>手写稿识别</small>
</div>
<br>
<div align="center">
  <img width="1168" height="820" alt="表格识别" src="https://github.com/user-attachments/assets/c639acb7-9ec7-4bd6-8321-7783a21c92b1" />
  <br>
  <small>表格的高精度还原</small>
</div>

## 🔍 演示地址
https://kayala.nyc.mn

---

## 🔑 API 密钥获取指南

### 1. 获取百度 PaddleOCR Token (`PADDLE_TOKEN`)
这是调用百度高精度官方模型所必须的令牌。
1. 访问并登录 [百度 AI Studio](https://aistudio.baidu.com/paddleocr)。
2. 点击**API** -> **点击获取令牌**。
3. 复制生成的 Token 字符串（一串长长的字母数字组合）。

### 2. 获取硅基流动 Token (`SILICON_TOKEN`)
用于调用 DeepSeek-OCR 及 Qwen3-VL 等开源生态模型。
1. 访问并注册 [硅基流动 (SiliconFlow)](https://cloud.siliconflow.cn/)。
2. 登录后进入控制台，在左侧导航栏找到 **API 密钥**。
3. 点击 **新建 API 密钥**，创建并复制你的 Token（通常以 `sk-` 开头）。

---

## 🚀 部署指南

### 方式一：Vercel 一键部署 (推荐)
1. 先将本项目 Fork 到你自己的 GitHub 账号下。
2. 点击下方按钮一键部署到 Vercel：
   
   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

3. 在 Vercel 的部署设置 (Environment Variables) 中，**必须添加以下两个环境变量**：
   - `PADDLE_TOKEN` : 填入你获取的百度 AI Studio Token。
   - `SILICON_TOKEN` : 填入你获取的硅基流动 API Key。
   - `PROXY_URL` : (可选但强烈推荐) 填入你的云代理服务地址，防止 Vercel 请求百度超时。具体部署方法见下方“高级玩法”。
4. 点击 Deploy，部署完成后即可拥有自己的在线 OCR 工具！

### 方式二：本地开发部署
### 1. 克隆仓库
```bash
git clone https://github.com/kayaladream/PaddleOCR.git
cd PaddleOCR
```

### 2.安装依赖
```bash
npm install
```

### 3.创建环境变量文件
```bash
在项目根目录创建 .env.local 文件，并填入以下内容：
PADDLE_TOKEN=你的百度AI_Studio_Token
SILICON_TOKEN=你的硅基流动API_Key
PROXY_URL=你的云代理地址 (本地开发网络好可不填)
```

### 4.启动本地开发服务器
```bash
npm run dev
```

应用将默认运行在 http://localhost:3000

## ☁️ 高级玩法：部署专属云代理 (防止 Vercel 失联)

由于 Vercel 的服务器位于海外，直连百度 AI Studio 接口时经常会遇到网络阻断或超时（尤其是在上传图片和下载文件阶段）。

我们在项目代码的 `cloud-proxy` 目录下提供了一个轻量级的 Node.js 代理服务，你可以使用 Google Cloud Run 将其零成本部署：

1. 登录 Google Cloud Console，进入 **Cloud Run**。
2. 创建服务，选择 **“从代码库持续部署”**，绑定你的 GitHub 仓库。
3. 源码目录选择 `/cloud-proxy`（或者在根目录运行，自动识别该目录下的 package.json）。
4. **关键配置（保持免费的秘诀）**：
   - **身份验证**：允许未通过身份验证的调用。
   - **CPU 分配**：仅在处理请求时分配 CPU。
   - **实例数下限：0** (一定要是 0，保证无人使用时休眠不扣费)。
   - **实例数上限：5** (防止恶意并发刷爆免费额度)。
5. 部署完成后，Google 会分配给你一个 HTTPS 域名（如 `https://xxx.a.run.app`）。
6. 将这个域名填入你 Vercel 的环境变量 **`PROXY_URL`** 中。系统在直连百度失败时，会自动通过该节点进行智能路由转发！

## 💡 使用建议
- 复杂公式预览：对于解析出的大型数学公式（LaTeX），你可以直接将其复制到 StackEdit 实时预览完美排版。
- 表格导出：识别出的 Markdown 表格区域，在页面上渲染后，直接用鼠标框选复制，粘贴进 Excel 中即可保留行列格式，非常适合财务报表录入。
- 网络超时提示：百度官方 API 为异步接口，单张图片的排队与解析最高容忍 120 秒，如遇卡顿请耐心等待或重试。
## 📄 开源许可
MIT License
