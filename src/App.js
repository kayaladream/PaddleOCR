import React, { useState, useRef, useEffect, useCallback } from 'react';
import 'katex/dist/katex.min.css';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { marked } from 'marked';
import TurndownService from 'turndown';
import DOMPurify from 'dompurify';
import './App.css';

// ====== 预处理：清理 Markdown，修复上标等常见误转 ======
const preprocessText = (text) => {
  if (!text) return '';

  // 保存表格
  const tables = [];
  text = text.replace(/\|[^\n]+\|\n\|[-|\s]+\|(?:\n\|[^\n]+\|)+/g, (match) => {
    tables.push(match);
    return `__TABLE_${tables.length - 1}__`;
  });

  // 基础清理
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

  // 常见上标/下标误转
  text = text.replace(/\s*\$\^\{([^}]+)\}\$\s*/g, (match, exponent) => {
    const superscripts = {
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
      'n': 'ⁿ', 'm': 'ᵐ'
    };
    if (exponent in superscripts) {
      return superscripts[exponent];
    }
    return '^' + exponent; // 其他未知上标保留 ^ 形式
  });

  // 恢复表格
  text = text.replace(/__TABLE_(\d+)__/g, (_, i) => `\n\n${tables[parseInt(i)]}\n\n`);

  return text.trim();
};

// ====== File → base64 ======
const fileToBase64 = (file) => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(file);
  });
};

// ====== Turndown ======
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

function App() {
  const[images, setImages] = useState([]);
  const [results, setResults] = useState([]);
  const[currentIndex, setCurrentIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingGlobal, setIsDraggingGlobal] = useState(false);
  const dropZoneRef = useRef(null);
  const[showUrlInput, setShowUrlInput] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const[isDraggingModal, setIsDraggingModal] = useState(false);
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 });
  const [modalOffset, setModalOffset] = useState({ x: 0, y: 0 });
  const [modalScale, setModalScale] = useState(1);
  const [editText, setEditText] = useState('');
  const editDivRef = useRef(null);

  // ====== 打字机流式效果 ======
  const typewriterEffect = useCallback((fullText, index) => {
    let pos = 0;
    const speed = 15;
    const timer = setInterval(() => {
      if (pos < fullText.length) {
        const current = fullText.substring(0, pos + 1);
        setStreamingText(current);
        setResults(prev => {
          const updated = [...prev];
          updated[index] = current;
          return updated;
        });
        pos++;
      } else {
        clearInterval(timer);
        setIsStreaming(false);
      }
    }, speed);
    return () => clearInterval(timer);
  },[]);

  // ====== 处理单张图片 ======
  const handleFile = useCallback(async (file, index) => {
    if (!file.type.startsWith('image/')) return;

    try {
      setIsStreaming(true);
      setStreamingText('');
      setResults(prev => {
        const newResults = [...prev];
        newResults[index] = '';
        return newResults;
      });

      const imageData = await fileToBase64(file);
      const response = await fetch('/api/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageData, mimeType: file.type }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: '请求失败' }));
        throw new Error(errorData.error || '服务异常');
      }

      const data = await response.json();
      const finalText = preprocessText(data.text || '');
      typewriterEffect(finalText, index);
    } catch (error) {
      console.error('识别失败:', error);
      const errMsg = `> ⚠️ **系统提示：图片处理失败**\n>\n> ${error.message}`;
      setResults(prev => {
        const updated = [...prev];
        updated[index] = errMsg;
        return updated;
      });
      setStreamingText(errMsg);
      setIsStreaming(false);
    }
  }, [typewriterEffect]);

  // ====== 并发控制 ======
  const concurrentProcess = async (items, processor, maxConcurrent = 2) => {
    const queue =[...items.entries()];
    const workers = new Array(maxConcurrent).fill().map(async () => {
      while (queue.length > 0) {
        const [realIdx, item] = queue.shift();
        await processor(item, realIdx).catch(err => console.error(err));
      }
    });
    await Promise.all(workers);
  };

  // ====== 粘贴监听 ======
  useEffect(() => {
    const handlePaste = async (e) => {
      if (editDivRef.current?.contains(e.target) || showModal) return;
      e.preventDefault();
      const items = Array.from(e.clipboardData.items);
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            setIsLoading(true);
            const url = URL.createObjectURL(file);
            const newIdx = images.length;
            setImages(prev => [...prev, url]);
            setResults(prev => [...prev, '']);
            setCurrentIndex(newIdx);
            await handleFile(file, newIdx);
            setIsLoading(false);
          }
        } else if (item.type === 'text/plain') {
          item.getAsString((text) => {
            if (text.match(/https?:\/\//i)) {
              setImageUrl(text);
              setShowUrlInput(true);
            }
          });
        }
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  },[images.length, handleFile, showModal]);

  // ====== 文件上传 ======
  const handleImageUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setIsLoading(true);
    try {
      const startIdx = images.length;
      const urls = files.map(f => URL.createObjectURL(f));
      setImages(prev => [...prev, ...urls]);
      setResults(prev =>[...prev, ...new Array(files.length).fill('')]);
      setCurrentIndex(startIdx);
      await concurrentProcess(files, (file, fileIdx) => handleFile(file, startIdx + fileIdx), 2);
    } catch (err) {
      alert('处理上传文件出错');
    } finally {
      setIsLoading(false);
      if (e.target) e.target.value = null;
    }
  };

  // ====== 导航 ======
  const handlePrevImage = () => {
    if (currentIndex > 0 && !isLoading && !isStreaming) setCurrentIndex(currentIndex - 1);
  };
  const handleNextImage = () => {
    if (currentIndex < images.length - 1 && !isLoading && !isStreaming) setCurrentIndex(currentIndex + 1);
  };

  // ====== 全局拖拽 ======
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
  },[]);

  const handleDragEnter = (e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.types.includes('Files')) setIsDragging(true); };
  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); };
  const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); if (!dropZoneRef.current.contains(e.relatedTarget)) setIsDragging(false); };
  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    setIsDraggingGlobal(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (!files.length) {
      const items = Array.from(e.dataTransfer.items);
      const urls = await Promise.all(items.filter(i => i.kind === 'string' && (i.type === 'text/uri-list' || i.type === 'text/plain')).map(i => new Promise(res => i.getAsString(res))));
      const imgUrl = urls.find(u => u?.match(/\.(jpg|jpeg|png|gif|webp|avif)(\?.*)?$/i));
      if (imgUrl) { setImageUrl(imgUrl); setShowUrlInput(true); }
      return;
    }
    setIsLoading(true);
    try {
      const startIdx = images.length;
      const urls = files.map(f => URL.createObjectURL(f));
      setImages(prev => [...prev, ...urls]);
      setResults(prev => [...prev, ...new Array(files.length).fill('')]);
      setCurrentIndex(startIdx);
      await concurrentProcess(files, (file, fileIdx) => handleFile(file, startIdx + fileIdx), 2);
    } catch (err) {
      alert('拖放处理失败');
    } finally {
      setIsLoading(false);
    }
  };

  // ====== URL 上传 ======
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
      if (!blob.type.startsWith('image/')) throw new Error('非图片文件');
      const file = new File([blob], 'url_image.jpg', { type: blob.type });
      const url = URL.createObjectURL(file);
      const newIndex = images.length;
      setImages(prev => [...prev, url]);
      setResults(prev => [...prev, '']);
      setCurrentIndex(newIndex);
      await handleFile(file, newIndex);
      setImageUrl('');
    } catch (err) {
      alert(`无法加载图片: ${err.message}`);
      setShowUrlInput(true);
    } finally {
      setIsLoading(false);
    }
  };

  // ====== 模态框相关 ======
  const handleImageClick = () => {
    if (!images[currentIndex]) return;
    setModalPosition({ x: 0, y: 0 });
    setModalScale(1);
    setShowModal(true);
  };
  const handleCloseModal = () => setShowModal(false);

  const handleCopyText = () => {
    if (!editText || isStreaming) return;
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
    if (isStreaming) return;
    const md = results[currentIndex] || '';
    setEditText(md);
    if (editDivRef.current) {
      if (document.activeElement !== editDivRef.current) {
        const html = marked.parse(md, { breaks: true });
        editDivRef.current.innerHTML = DOMPurify.sanitize(html);
      }
    }
  }, [currentIndex, results, isStreaming]);

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

  // ====== 渲染 ======
  return (
    <div className="app">
      <header>
        <a
          href="https://github.com/kayaladream/PaddleOCR"
          target="_blank"
          rel="noopener noreferrer"
          className="github-link"
          title="在 GitHub 上查看源码"
        >
          <svg height="32" aria-hidden="true" viewBox="0 0 16 16" version="1.1" width="32">
            <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
          </svg>
        </a>
        <h1>文档解析的事，交给PaddleOCR</h1>
        <p>
          <b>基于PaddleOCR-VL API的智能文字识别解决方案，可精准识别多语言文字、表格等。</b>
          <br />
          识别出的表格复制至 Excel 即可保留格式使用，公式源码可复制到
          <a 
            href="https://stackedit.io/app#" 
            target="_blank" 
            rel="noopener noreferrer"
            style={{ color: '#1233E0', textDecoration: 'underline', fontWeight: '500', marginLeft: '4px', marginRight: '4px' }}
          >
            这里
          </a>
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
            aria-label="图片上传区域"
          >
            <div className="upload-container">
              <label className="upload-button" htmlFor="file-input">
                {images.length > 0 ? '添加新的图片' : '上传图片'}
              </label>
              <input id="file-input" type="file" accept="image/*" onChange={handleImageUpload} multiple hidden />
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
            {!images.length && !isDragging && !showUrlInput && <p className="upload-hint">或将图片拖放到此处 / 粘贴图片</p>}
            {isDragging && <div className="dragging-overlay-text">松开即可上传图片</div>}
          </div>
          {isDraggingGlobal && <div className="drag-overlay active"></div>}
          {images.length > 0 && (
            <div className="images-preview">
              <div className="image-navigation">
                <button onClick={handlePrevImage} disabled={currentIndex === 0 || isLoading || isStreaming} className="nav-button">←</button>
                <span className="image-counter">{currentIndex + 1} / {images.length}</span>
                <button onClick={handleNextImage} disabled={currentIndex === images.length - 1 || isLoading || isStreaming} className="nav-button">→</button>
              </div>
              <div className={`image-preview ${isLoading && !results[currentIndex] ? 'loading' : ''}`}>
                <img
                  key={images[currentIndex]} src={images[currentIndex]} alt={`预览 ${currentIndex + 1}`} onClick={handleImageClick} style={{ cursor: images[currentIndex] ? 'zoom-in' : 'default' }}
                  onError={(e) => { console.error("加载图片失败:", images[currentIndex]); e.target.alt = '图片加载失败'; e.target.style.display = 'none'; e.target.closest('.image-preview')?.classList.add('load-error'); }}
                />
                {isLoading && !results[currentIndex] && <div className="loading-overlay">{isStreaming ? '识别中...' : '处理中...'}</div>}
              </div>
            </div>
          )}
        </div>

        {(images.length > 0 || isLoading || isStreaming) && (
          <div className="result-section">
            <div className="result-container">
              {isLoading && !isStreaming && results[currentIndex] == null && <div className="loading result-loading">等待识别...</div>}

              {isStreaming && (
                <div className="result-text">
                  <div className="result-header"><span>第 {currentIndex + 1} 张图片的识别结果 (识别中...)</span></div>
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
                      {streamingText}
                    </ReactMarkdown>
                  </div>
                </div>
              )}

              {!isStreaming && results[currentIndex] != null && (
                <div className="result-text editing-area">
                  <div className="result-header">
                    <span>编辑第 {currentIndex + 1} 张图片的结果</span>
                    <button className="copy-button" onClick={handleCopyText}>复制内容</button>
                  </div>
                  <div ref={editDivRef} contentEditable={true} className="edit-content-editable" onInput={handleInput} onCopy={handleManualCopy}
                       suppressContentEditableWarning={true} aria-label={`编辑识别结果 ${currentIndex + 1}`} spellCheck="false" />
                </div>
              )}

              {!isLoading && !isStreaming && results[currentIndex] == null && images.length > 0 && (
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
            <button className="modal-close" onClick={handleCloseModal} onMouseDown={(e) => e.stopPropagation()}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
