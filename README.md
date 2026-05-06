# 基于 PaddleOCR-VL 的智能 OCR 系统

## 项目概述
依托百度 PaddleOCR-VL 文档解析 API 的智能文字识别解决方案，支持多语言印刷体、手写体文字及表格识别，输出标准 Markdown 格式。

## 核心特性
- 高精度文字提取
- 多语种智能识别
- 手写体文字解析
- 流畅优雅的视觉动效（流式渐变）
- 自适应多端响应式布局
- Markdown 编辑器即时修订
- 多元化图像输入：文件选择、拖放、粘贴、远程 URL

## 实际效果
<div align="center">
  <img width="1166" height="775" alt="9c2efa22-1a58-4a68-be8d-c238e8146d86" src="https://github.com/user-attachments/assets/9ab0353a-01e1-4f16-93d4-4228ad749131" />
  <br>
  <small>手写稿的识别</small>
</div>
<br>
<div align="center">
  <img width="1168" height="776" alt="5acc1e00-03fd-41eb-92ad-473a28295ca8" src="https://github.com/user-attachments/assets/81b0f3a6-3b4f-46f1-ac73-d8c08b4d0855" />
  <br>
  <small>表格的识别</small>
</div>

## 完全免费
使用百度 PaddleOCR 免费 API token

## 部署指南
1. 点击下方按钮一键部署到 Vercel（先 Fork 本项目到你自己的 GitHub）  
   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

2. 在 Vercel 项目设置 → Environment Variables 添加：
   - `Name`: `PADDLE_TOKEN`
   - `Value`: 你的 PaddleOCR API token

3. 部署完成后即可使用。

## 本地开发
1. 克隆仓库
```bash
git clone https://github.com/你的用户名/PaddleOCR-Reader.git
cd PaddleOCR-Reader
```

2. 安装依赖
```bash
npm install
```

3. 创建 `.env.local` 文件，内容为：
```
PADDLE_TOKEN=你的token
```

4. 启动
```bash
npm start
```

应用将运行在 http://localhost:3000

## 技术架构
- React.js
- PaddleOCR-VL API（布局解析）
- CSS3 动态效果
- React Markdown + KaTeX
- Vercel 部署

## 使用建议
- 请确保 PaddleOCR token 有效
- 上传清晰度高的图片效果更佳
- 表格可直接复制到 Excel

## 开源许可
MIT
```
