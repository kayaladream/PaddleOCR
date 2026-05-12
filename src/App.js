import React, { useState, useRef, useEffect, useCallback } from 'react';
import 'katex/dist/katex.min.css';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { marked } from 'marked';
import TurndownService from 'turndown';
import DOMPurify from 'dompurify';
import './App.css';

// ====== 模型列表定义 ======
const MODELS = [
  {
    id: 'baidu-vl-1.5',
    name: 'PaddleOCR-VL-1.5',
    badge: 'pp.png',
    desc: '突破扭曲倾斜，多模态行业SOTA',
    channel: 'baidu'
  },
  {
    id: 'baidu-ocrv5',
    name: 'PP-OCRv5',
    badge: 'pp.png',
    desc: '超轻量文字识别，又快又准',
    channel: 'baidu'
  },
  {
    id: 'baidu-structurev3',
    name: 'PP-StructureV3',
    badge: 'pp.png',
    desc: '通用文档解析，高精度零幻觉',
    channel: 'baidu'
  },
  {
    id: 'sili-vl-1.5',
    name: 'PaddleOCR-VL-1.5',
    badge: 'silicon.png',
    desc: '硅基流动加速的业界SOTA文档大模型',
    channel: 'silicon',
    apiName: 'PaddlePaddle/PaddleOCR-VL-1.5'
  },
  {
    id: 'sili-deepseek',
    name: 'DeepSeek-OCR',
    badge: 'silicon.png',
    desc: '深度求索推出的顶尖视觉文字识别模型',
    channel: 'silicon',
    apiName: 'deepseek-ai/DeepSeek-OCR'
  }
];

// ====== 预处理：清理 Markdown ======
const preprocessText = (text) => {
  if (!text) return '';
  text = text.replace(/[a-zA-Z_]*<\|\/?ref\|>\[\[.*?\]\]<\|\/?det\|>/g, '');
  text = text.replace(/<\|\/?(ref|det|grounding)\|>/g, '');
  text = text.replace(/\[\[\d+,\s*\d+,\s*\d+,\s*\d+\]\]/g, '');
  // === 🚀 新增：智能修复 LaTeX 定界符与小模型语法错误 ===
  
  // 1. 将 LaTeX 的 \( \) 和 \[ \] 标准化为 $ 和 $$
  // 注意：在 JS 的 replace 中，$$ 代表插入一个 $ 字符，$$$$ 代表插入两个
  text = text.replace(/\\\(/g, '$$');
  text = text.replace(/\\\)/g, '$$');
  text = text.replace(/\\\[/g, '$$$$');
  text = text.replace(/\\\]/g, '$$$$');

  // 2. 修复模型漏掉下划线的常见错误 (如 C{3}^{1} -> C_{3}^{1}, X{1} -> X_{1})
  // 匹配：大写或小写字母紧跟 {数字}
  text = text.replace(/([A-Za-z])\{(\d+)\}/g, '$1_{$2}');
  
  // 3. 修复求和符号漏掉下划线 (如 \sum{i=1}^{n} -> \sum_{i=1}^{n})
  text = text.replace(/\\sum\{([^}]+)\}/g, '\\sum_{$1}');
  
  // =================================================
  const tables = [];
  text = text.replace(/\|[^\n]+\|\n\|[-|\s]+\|(?:\n\|[^\n]+\|)+/g, (match) => {
    tables.push(match);
    return `__TABLE_${tables.length - 1}__`;
  });
  text = text.replace(/\\\\\(/g, '$');
  text = text.replace(/\\\\\)/g, '$');
  text = text.replace(/\\\\\[/g, '$$');
  text = text.replace(/\\\\\]/g, '$$');
  text = text.replace(/```[\s\S]*?```/g, (match) => match.slice(3, -3).trim());
  text = text.replace(/```\w*\n?/g, '');
  text = text.replace(/(\d+)\.\s*\n+/g, '$1. ');
  text = text.replace(/\n*\$\$\s*([\s\S]*?)\s*\$\$\n*/g, (_, formula) => `\n\n$$${formula.trim()}$$\n\n`);
  text = text.replace(/\$\s*(.*?)\s*\$/g, (_, formula) => `$${formula.trim()}$`);
  text = text.replace(/(\d+\.)\s*(\$\$[\s\S]*?\$\$)/g, '$1\n\n$2');
  text = text.replace(/(\d+)\.\s+/g, '$1');
  text = text.replace(/(\d+)\.\s+/g, '$1.');
  text = text.replace(/(\d+)\)\s+/g, '$1)');
  text = text.replace(/-\s+/g, '-');
  text = text.replace(/\*\s+/g, '*');
  text = text.replace(/\+\s+/g, '+');
  text = text.replace(/>\s+/g, '>');
  text = text.replace(/#\s+/g, '#');
  text = text.replace(/\n{2,}/g, '\n\n');
  text = text.replace(/\s*\$\^\{([^}]+)\}\$\s*/g, (match, exponent) => {
    const superscripts = {
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
      'n': 'ⁿ', 'm': 'ᵐ'
    };
    if (exponent in superscripts) return superscripts[exponent];
    return '^' + exponent;
  });
  text = text.replace(/(\d)\*(?=\d)/g, '$1\\*');
  text = text.replace(/(?<=\d)\*(\d)/g, '\\*$1');
  text = text.replace(/__TABLE_(\d+)__/g, (_, i) => `\n\n${tables[parseInt(i)]}\n\n`);
  return text.trim();
};

const fileToBase64 = (file) => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(file);
  });
};

const turndownService = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '*',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
});
turndownService.keep(['table', 'thead', 'tbody', 'tr', 'th', 'td']);
turndownService.addRule('katex', {
  filter: function (node) {
    return (
      (node.nodeName === 'SPAN' && node.classList.contains('katex-display')) ||
      (node.nodeName === 'SPAN' && node.classList.contains('katex'))
    );
  },
  replacement: function (content, node) {
    const latex = node.querySelector('annotation[encoding="application/x-tex"]');
    if (latex) {
      const formula = latex.textContent;
      if (node.classList.contains('katex-display')) {
        return `\n\n$$${formula}$$\n\n`;
      } else {
        return `$${formula}$`;
      }
    }
    return node.outerHTML;
  },
});

// ====== 并发处理工具 ======
const concurrentProcess = async (items, processor, maxConcurrent = 2) => {
  const queue = [...items.entries()];
  const workers = new Array(maxConcurrent).fill().map(async () => {
    while (queue.length > 0) {
      const [realIdx, item] = queue.shift();
      await processor(item, realIdx).catch(err => console.error(err));
    }
  });
  await Promise.all(workers);
};

// ====== 动态加载 PDF.js ======
let pdfjsLibPromise = null;
const loadPdfJs = () => {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = new Promise((resolve, reject) => {
      if (window.pdfjsLib) {
        resolve(window.pdfjsLib);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      script.onerror = () => reject(new Error('PDF.js 加载失败'));
      document.head.appendChild(script);
    });
  }
  return pdfjsLibPromise;
};

// ====== PDF 转图片工具 ======
const pdfToImages = async (file) => {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const images = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    images.push(new File([blob], `${file.name || 'pdf'}_page_${i}.png`, { type: 'image/png' }));
  }
  return images;
};

function App() {
  const [images, setImages] = useState([]);
  const [results, setResults] = useState([]);
  const [resultModels, setResultModels] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingGlobal, setIsDraggingGlobal] = useState(false);
  const dropZoneRef = useRef(null);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState({});
  const [completedCount, setCompletedCount] = useState(0);
  const completedIndicesRef = useRef(new Set());

  const [isDraggingModal, setIsDraggingModal] = useState(false);
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 });
  const [modalOffset, setModalOffset] = useState({ x: 0, y: 0 });
  const [modalScale, setModalScale] = useState(1);
  const [editText, setEditText] = useState('');
  const editDivRef = useRef(null);

  const [selectedModel, setSelectedModel] = useState(MODELS[0]);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const typewriterEffect = useCallback((fullText, index, shouldStream) => {
    if (!shouldStream) {
      setResults(prev => {
        const updated = [...prev];
        updated[index] = fullText;
        return updated;
      });
      setStreamingStatus(prev => ({ ...prev, [index]: false }));
      return;
    }
    let pos = 0;
    const speed = 15;
    const step = Math.max(2, Math.ceil(fullText.length / 180));
    const timer = setInterval(() => {
      if (pos < fullText.length) {
        pos += step;
        const current = fullText.substring(0, pos);
        setResults(prev => {
          const updated = [...prev];
          updated[index] = current;
          return updated;
        });
      } else {
        clearInterval(timer);
        setStreamingStatus(prev => ({ ...prev, [index]: false }));
      }
    }, speed);
    return () => clearInterval(timer);
  }, []);

  const markComplete = useCallback((index) => {
    if (!completedIndicesRef.current.has(index)) {
      completedIndicesRef.current.add(index);
      setCompletedCount(prev => prev + 1);
    }
  }, []);

  const handleFile = useCallback(async (file, index, isBatch = false) => {
    if (!file.type.startsWith('image/')) return;
    try {
      setStreamingStatus(prev => ({ ...prev, [index]: true }));
      // 开始识别前先将对应位置清空，避免显示旧结果
      setResults(prev => {
        const newResults = [...prev];
        newResults[index] = '';
        return newResults;
      });

      const imageData = await fileToBase64(file);

      let response;
      let lastError = null;

      const maxRetries = selectedModel.channel === 'baidu' ? 3 : 1;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 1) {
            // 根据上一次失败的错误信息判断原因
            let reason = '服务请求异常';
            const msg = lastError?.message || '';
            if (msg.includes('fetch') || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
              reason = '网络连接异常';
            } else if (msg.includes('状态码') || msg.includes('status') || msg.includes('503') || msg.includes('502') || msg.includes('504')) {
              reason = '模型服务暂时不可用';
            } else if (msg.includes('超时') || msg.includes('timeout')) {
              reason = '请求超时';
            } else if (msg.includes('环境变量')) {
              reason = '服务配置错误';
            }

            setResults(prev => {
              const updated = [...prev];
              updated[index] = `> ⚠️ **${reason}，将在 10 秒后自动重试（${attempt}/${maxRetries}）**\n>\n> 🔄 **正在重试中...**`;
              return updated;
            });
          }

          response = await fetch('/api/recognize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              imageData,
              mimeType: file.type,
              modelId: selectedModel.id,
              channel: selectedModel.channel,
              apiName: selectedModel.apiName
            }),
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: '请求失败' }));
            throw new Error(errorData.error || '服务异常');
          }

          break;
        } catch (err) {
          lastError = err;
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 10000));
          } else {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      if (!response || !response.ok) {
        throw lastError || new Error('请求失败');
      }

      const data = await response.json();
      const finalText = preprocessText(data.text || '');

      // 记录本次使用的模型信息
      setResultModels(prev => {
        const updated = [...prev];
        updated[index] = { channel: selectedModel.channel, name: selectedModel.name };
        return updated;
      });

      // 直接输出识别结果，不添加任何前缀
      typewriterEffect(finalText, index, !isBatch);
      markComplete(index);

    } catch (error) {
      console.error('识别失败:', error);
      const errMsg = `> ⚠️ **系统提示：图片处理失败**\n>\n> ${error.message}`;
      setResults(prev => {
        const updated = [...prev];
        updated[index] = errMsg;
        return updated;
      });
      setStreamingStatus(prev => ({ ...prev, [index]: false }));
      markComplete(index);
    }
  }, [typewriterEffect, selectedModel, markComplete]);

  const processFiles = useCallback(async (files) => {
    setIsLoading(true);
    try {
      const expandedFiles = [];
      for (const file of files) {
        if (file.type === 'application/pdf') {
          try {
            const pdfImages = await pdfToImages(file);
            expandedFiles.push(...pdfImages);
          } catch (err) {
            console.error('PDF 转换失败:', err);
            alert('PDF 处理失败：' + err.message);
          }
        } else if (file.type.startsWith('image/')) {
          expandedFiles.push(file);
        }
      }
      if (expandedFiles.length === 0) {
        alert('没有可处理的文件（仅支持图片和 PDF）');
        setIsLoading(false);
        return;
      }
      const startIdx = images.length;
      const urls = expandedFiles.map(f => URL.createObjectURL(f));
      setImages(prev => [...prev, ...urls]);
      setResults(prev => [...prev, ...new Array(expandedFiles.length).fill('')]);
      setResultModels(prev => [...prev, ...new Array(expandedFiles.length).fill(null)]);
      setCurrentIndex(startIdx);
      setIsLoading(false);
      const isBatch = expandedFiles.length > 1;
      await concurrentProcess(expandedFiles, (file, fileIdx) => handleFile(file, startIdx + fileIdx, isBatch), 2);
    } catch (err) {
      alert('处理文件时出错：' + err.message);
      setIsLoading(false);
    }
  }, [images.length, handleFile]);

  useEffect(() => {
    const handlePaste = async (e) => {
      if (editDivRef.current?.contains(e.target) || showModal) return;
      e.preventDefault();
      const items = Array.from(e.clipboardData.items);
      const newFiles = [];
      for (const item of items) {
        if (item.type.startsWith('image/') || item.type === 'application/pdf') {
          const file = item.getAsFile();
          if (file) newFiles.push(file);
        } else if (item.type === 'text/plain') {
          item.getAsString((text) => {
            if (text.match(/https?:\/\//i)) {
              setImageUrl(text);
              setShowUrlInput(true);
            }
          });
        }
      }
      if (newFiles.length > 0) {
        processFiles(newFiles);
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [processFiles, showModal]);

  const handleImageUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    await processFiles(files);
    if (e.target) e.target.value = null;
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    setIsDraggingGlobal(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (!files.length) {
      const items = Array.from(e.dataTransfer.items);
      const urls = await Promise.all(items.filter(i => i.kind === 'string' && (i.type === 'text/uri-list' || i.type === 'text/plain')).map(i => new Promise(res => i.getAsString(res))));
      const imgUrl = urls.find(u => u?.match(/\.(jpg|jpeg|png|gif|webp|avif)(\?.*)?$/i));
      if (imgUrl) { setImageUrl(imgUrl); setShowUrlInput(true); }
      return;
    }
    processFiles(files);
  };

  const handleUrlSubmit = async (e) => {
    e.preventDefault();
    if (!imageUrl) return;
    setIsLoading(true);
    setShowUrlInput(false);
    try {
      let blob;
      try {
        const res = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error();
        blob = await res.blob();
      } catch {
        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(imageUrl)}`;
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error();
        blob = await res.blob();
      }
      const file = new File([blob], 'url_image.jpg', { type: blob.type });
      await processFiles([file]);
      setImageUrl('');
    } catch (err) {
      alert(`无法加载图片: ${err.message}`);
      setShowUrlInput(true);
      setIsLoading(false);
    }
  };

  const handlePrevImage = () => {
    if (currentIndex > 0 && !isLoading) setCurrentIndex(currentIndex - 1);
  };
  const handleNextImage = () => {
    if (currentIndex < images.length - 1 && !isLoading) setCurrentIndex(currentIndex + 1);
  };

  useEffect(() => {
    const dragEnter = (e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer?.types.includes('Files')) setIsDraggingGlobal(true); };
    const dragOver = (e) => { e.preventDefault(); e.stopPropagation(); };
    const dragLeave = (e) => { e.preventDefault(); e.stopPropagation(); if (!e.relatedTarget || e.relatedTarget === document.documentElement) { setIsDraggingGlobal(false); setIsDragging(false); } };
    const drop = (e) => { e.preventDefault(); e.stopPropagation(); if (dropZoneRef.current && !dropZoneRef.current.contains(e.target)) { setIsDraggingGlobal(false); setIsDragging(false); } };
    window.addEventListener('dragenter', dragEnter);
    window.addEventListener('dragover', dragOver);
    window.addEventListener('dragleave', dragLeave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', dragEnter);
      window.removeEventListener('dragover', dragOver);
      window.removeEventListener('dragleave', dragLeave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const handleDragEnter = (e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.types.includes('Files')) setIsDragging(true); };
  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); };
  const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); if (!dropZoneRef.current.contains(e.relatedTarget)) setIsDragging(false); };

  useEffect(() => {
    if (streamingStatus[currentIndex]) return;
    const md = results[currentIndex] || '';
    setEditText(md);
    if (editDivRef.current) {
      if (document.activeElement !== editDivRef.current) {
        const html = marked.parse(md, { breaks: true });
        editDivRef.current.innerHTML = DOMPurify.sanitize(html);
      }
    }
  }, [currentIndex, results, streamingStatus]);

  const handleCopyText = () => {
    if (!editText || streamingStatus[currentIndex]) return;
    const plain = editText.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2');
    navigator.clipboard.writeText(plain.trim()).then(() => {
      const btn = document.querySelector('.copy-button');
      if (btn) { btn.textContent = '已复制'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = '复制内容'; btn.classList.remove('copied'); }, 1500); }
    }).catch(() => alert('复制失败'));
  };

  const handleInput = (e) => {
    const html = e.currentTarget.innerHTML;
    const newMd = turndownService.turndown(html);
    setEditText(newMd);
    setResults(prev => { const u = [...prev]; u[currentIndex] = newMd; return u; });
  };

  const handleManualCopy = (e) => {
    e.preventDefault();
    const sel = window.getSelection().toString();
    const plain = sel.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2');
    e.clipboardData.setData('text/plain', plain);
  };

  useEffect(() => {
    const move = (e) => {
      if (!isDraggingModal) return;
      const clientX = e.touches?.[0]?.clientX ?? e.clientX;
      const clientY = e.touches?.[0]?.clientY ?? e.clientY;
      setModalPosition({ x: clientX - modalOffset.x, y: clientY - modalOffset.y });
    };
    const end = () => setIsDraggingModal(false);
    if (isDraggingModal) {
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', end);
      window.addEventListener('touchmove', move, { passive: false });
      window.addEventListener('touchend', end);
    }
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
    };
  }, [isDraggingModal, modalOffset]);

  const handleModalMouseDown = (e) => {
    if (e.target.classList.contains('modal-close') || e.button !== 0) return;
    const clientX = e.touches?.[0]?.clientX ?? e.clientX;
    const clientY = e.touches?.[0]?.clientY ?? e.clientY;
    setIsDraggingModal(true);
    setModalOffset({ x: clientX - modalPosition.x, y: clientY - modalPosition.y });
  };
  const handleModalWheel = (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0005 * modalScale;
    setModalScale(prev => Math.max(0.1, Math.min(10, prev + delta)));
  };

  const modelInfoText = resultModels[currentIndex]
    ? `（${resultModels[currentIndex].channel === 'baidu' ? '百度' : '硅基流动'} · ${resultModels[currentIndex].name}）`
    : '';
  const currentIsStreaming = streamingStatus[currentIndex] || false;
  const showResultsSection = images.length > 0 || isLoading || Object.values(streamingStatus).some(v => v);

  const getCurrentImageStatus = () => {
    if (streamingStatus[currentIndex]) return { text: '识别中', className: 'status-streaming' };
    if (results[currentIndex] && results[currentIndex].trim().length > 0) return { text: '已完成', className: 'status-completed' };
    if (results[currentIndex] === '' && !streamingStatus[currentIndex]) return { text: '等待中', className: 'status-pending' };
    return { text: '未开始', className: 'status-pending' };
  };
  const currentStatus = getCurrentImageStatus();

  return (
    <div className="app">
      <div style={{ display: 'none' }}>
        {MODELS.map(m => m.badge && <img key={`preload-${m.id}`} src={m.badge} alt="preload" />)}
      </div>
      <header>
        <a href="https://github.com/kayaladream/PaddleOCR" target="_blank" rel="noopener noreferrer" className="github-link" title="在 GitHub 上查看源码">
          <svg height="32" aria-hidden="true" viewBox="0 0 16 16" version="1.1" width="32">
            <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
          </svg>
        </a>
        <h1>文档解析的事，交给PaddleOCR</h1>
        <p>
          <b>基于PaddleOCR-VL API的智能文字识别解决方案，可精准识别多语言文字、表格等。</b>
          <br />
          识别出的表格复制至 Excel 即可保留格式使用，公式源码可复制到
          <a href="https://stackedit.io/app#" target="_blank" rel="noopener noreferrer" style={{ color: '#1233E0', textDecoration: 'underline', fontWeight: '500', marginLeft: '4px', marginRight: '4px' }}>这里</a>
          预览渲染效果。
        </p>
      </header>
      <main className={images.length > 0 ? 'has-content' : ''}>
        <div className={`upload-section ${images.length > 0 ? 'with-image' : ''}`}>
          <div
            ref={dropZoneRef}
            className={`upload-zone ${isDragging ? 'dragging' : ''}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            aria-label="文件上传区域"
          >
            <div className="upload-container">
              <label className="upload-button" htmlFor="file-input">
                {images.length > 0 ? '添加新的图片/PDF' : '上传图片/PDF'}
              </label>
              <input id="file-input" type="file" accept="image/*,application/pdf" onChange={handleImageUpload} multiple hidden />
              <button type="button" className="url-button" onClick={() => setShowUrlInput(!showUrlInput)}>
                {showUrlInput ? '取消链接输入' : '使用链接上传'}
              </button>
            </div>
            {showUrlInput && (
              <form onSubmit={handleUrlSubmit} className="url-form">
                <input type="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="粘贴图片链接 (URL)" className="url-input" required />
                <button type="submit" className="url-submit">确认</button>
              </form>
            )}
            {!images.length && !isDragging && !showUrlInput && <p className="upload-hint">或将图片/PDF拖放到此处 / 粘贴图片</p>}
            <div className="model-selector-container">
              <div className="model-selector-wrapper" ref={dropdownRef}>
                <span className="model-label-outside">选择模型</span>
                <div className="model-selector" onClick={(e) => { e.stopPropagation(); setShowDropdown(!showDropdown); }}>
                  <div className="model-selector-header">
                    <span className="model-current-name">{selectedModel.name}</span>
                    {selectedModel.badge && <img src={selectedModel.badge} alt="badge" className="model-badge" />}
                    <span className="model-arrow" style={{ transform: showDropdown ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                  </div>
                </div>
                {showDropdown && (
                  <div className="model-dropdown-list">
                    {MODELS.map(model => (
                      <div
                        key={model.id}
                        className="model-dropdown-item"
                        onClick={(e) => { e.stopPropagation(); setSelectedModel(model); setShowDropdown(false); }}
                      >
                        <div className="model-item-top">
                          <span className="model-item-name">{model.name}</span>
                          {model.badge && <img src={model.badge} alt="badge" className="model-item-badge" />}
                        </div>
                        <div className="model-item-desc">{model.desc}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {isDragging && <div className="dragging-overlay-text">松开即可上传文件</div>}
          </div>
          {isDraggingGlobal && <div className="drag-overlay active"></div>}
          {images.length > 0 && (
            <div className="images-preview">
              <div className="image-navigation">
                <button onClick={handlePrevImage} disabled={currentIndex === 0 || isLoading} className="nav-button">←</button>
                <span className="image-counter">{currentIndex + 1} / {images.length}</span>
                <button onClick={handleNextImage} disabled={currentIndex === images.length - 1 || isLoading} className="nav-button">→</button>
                <span className="progress-indicator">识别进度: {completedCount} / {images.length}</span>
              </div>
              <div className={`image-preview ${isLoading && !results[currentIndex] ? 'loading' : ''}`}>
                <img
                  key={images[currentIndex]}
                  src={images[currentIndex]}
                  alt={`预览 ${currentIndex + 1}`}
                  onClick={() => { if (images[currentIndex]) { setModalPosition({ x: 0, y: 0 }); setModalScale(1); setShowModal(true); } }}
                  style={{ cursor: images[currentIndex] ? 'zoom-in' : 'default' }}
                  onError={(e) => { console.error("加载图片失败:", images[currentIndex]); e.target.alt = '图片加载失败'; e.target.style.display = 'none'; e.target.closest('.image-preview')?.classList.add('load-error'); }}
                />
                {images[currentIndex] && (
                  <div className={`image-status-badge ${currentStatus.className}`}>
                    {currentStatus.text}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        {showResultsSection && (
          <div className="result-section">
            <div className="result-container">
              {isLoading && !currentIsStreaming && results[currentIndex] == null && <div className="loading result-loading">等待识别...</div>}
              {currentIsStreaming && (
                <div className="result-text">
                  <div className="result-header"><span>第 {currentIndex + 1} 张图片的识别结果 (识别中...) {modelInfoText}</span></div>
                  <div className="gradient-text">
                    <ReactMarkdown
                      remarkPlugins={[remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                      components={{
                        table: ({node, ...props}) => (<div style={{overflowX:'auto', maxWidth:'100%'}}><table className="markdown-table" {...props} /></div>),
                        th: ({node, ...props}) => <th className="markdown-th" {...props} />,
                        td: ({node, ...props}) => <td className="markdown-td" {...props} />,
                      }}
                    >
                      {results[currentIndex] || ''}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
              {!currentIsStreaming && results[currentIndex] != null && (
                <div className="result-text editing-area">
                  <div className="result-header">
                    <span>编辑第 {currentIndex + 1} 张图片的结果 {modelInfoText}</span>
                    <button className="copy-button" onClick={handleCopyText}>复制内容</button>
                  </div>
                  <div ref={editDivRef} contentEditable={true} className="edit-content-editable" onInput={handleInput} onCopy={handleManualCopy}
                       suppressContentEditableWarning={true} aria-label={`编辑识别结果 ${currentIndex + 1}`} spellCheck="false" />
                </div>
              )}
              {!isLoading && !currentIsStreaming && results[currentIndex] == null && images.length > 0 && (
                <div className="result-placeholder">
                  <span style={{fontWeight:'bold'}}>⚠️ 系统提示</span><br /><br />当前图片状态异常，暂无识别结果或由于网络中断导致失败，请尝试重新点击上传。
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      {showModal && images[currentIndex] && (
        <div className="modal-overlay">
          <div
            className="modal-content"
            onMouseDown={handleModalMouseDown}
            onWheel={handleModalWheel}
            onTouchStart={handleModalMouseDown}
            style={{
              transform: `translate(${modalPosition.x}px, ${modalPosition.y}px) scale(${modalScale})`,
              cursor: isDraggingModal ? 'grabbing' : 'grab',
              transition: isDraggingModal ? 'none' : 'transform 0.1s ease-out',
              touchAction: 'none',
              userSelect: 'none',
            }}
          >
            <img src={images[currentIndex]} alt="放大预览" draggable="false" style={{ pointerEvents: 'none', userSelect: 'none' }} />
            <button className="modal-close" onClick={() => setShowModal(false)} onMouseDown={(e) => e.stopPropagation()}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
