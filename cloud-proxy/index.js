// index.js
const http = require('http');
const https = require('https');

// Cloud Run 的动态端口，默认 8080
const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
    // 健康检查路由 (Cloud Run 部署时可能会用到)
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('OK');
    }

    const targetUrl = decodeURIComponent(req.url.slice(1));
    console.log(`[${new Date().toLocaleTimeString()}] 收到请求: ${req.method} ${targetUrl}`);

    if (!targetUrl || (!targetUrl.includes('aistudio-app.com') && !targetUrl.includes('bcebos.com'))) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    const targetUrlObj = new URL(targetUrl);
    const headers = { ...req.headers };
    delete headers.host;
    headers.host = targetUrlObj.host;

    const options = {
        hostname: targetUrlObj.hostname,
        port: targetUrlObj.port || 443,
        path: targetUrlObj.pathname + targetUrlObj.search,
        method: req.method,
        headers: headers,
        family: 4  // IPv4 强制策略
    };

    const proxyReq = https.request(options, (proxyRes) => {
        console.log(`[${new Date().toLocaleTimeString()}] 百度返回状态码: ${proxyRes.statusCode}`);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
        console.error('代理转发错误:', e.message);
        if (!res.headersSent) {
            res.writeHead(500);
            res.end(e.message);
        }
    });

    req.pipe(proxyReq);

}).listen(PORT, '0.0.0.0', () => {
    // 打印日志适配
    console.log(`Cloud Run 代理服务器正在运行，监听端口 ${PORT} (已强制 IPv4)`);
});
