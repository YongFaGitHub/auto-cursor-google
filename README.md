# auto-cursor-google
自动桥接cursor和谷歌浏览器的一个小插件，能在cursor agent模式下自动测试和修复bug

package.json 替换

    "predev": "pkill -f 'Google Chrome' || true && open -n -a \"Google Chrome\" --args --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug-profile",
    "dev": "vite & sleep 2 && node console-monitor.js \"$npm_config_level\"",
然后吧下面的说明和js丢给 cursor或者 写成一个cursor的rular文件，


# Chrome 远程调试工具使用指南

## 1. 快速开始

### 启动调试模式的 Chrome：
```bash
# macOS
pnpm dev  # 或使用: open -n -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug-profile

# Windows
pnpm dev  # 或使用: "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-debug-profile

# Linux
pnpm dev
```

## 2. 基本命令

### 监控页面：
```bash
# 列出可用页面
node console-monitor.js

# 监控特定页面（支持三种模式：open/normal/strict）
node console-monitor.js <PAGE_ID> [mode]
```

### 常用操作：
```bash
# 截图
node console-monitor.js <PAGE_ID> screenshot [filename]

# 元素操作
node console-monitor.js <PAGE_ID> element-click "#button"    # 点击元素
node console-monitor.js <PAGE_ID> wait-element ".loading"    # 等待元素
node console-monitor.js <PAGE_ID> get-text ".message"        # 获取文本

# 页面操作
node console-monitor.js <PAGE_ID> goto "https://example.com" # 页面跳转
node console-monitor.js <PAGE_ID> refresh                    # 页面刷新
```

## 3. 监控内容

### Console 日志：
- normal：显示 info、warn、error 级别日志
- strict：只显示错误和异常日志

### 网络请求：
- 自动显示 API 请求和错误响应
- 自动过滤静态资源和开发相关请求
- 自动脱敏敏感信息

## 4. 注意事项

1. 确保 Chrome 完全关闭后再启动调试模式
2. 默认使用 9222 端口，确保端口未被占用
3. 使用 `pnpm dev` 是最简单的启动方式
4. 建议使用 normal 模式进行日常调试

## 5. 高级功能

### Cookie 操作：
```bash
# 列出所有 Cookie
node console-monitor.js <PAGE_ID> cookie list

# 设置/获取/删除 Cookie
node console-monitor.js <PAGE_ID> cookie set "name" "value"
node console-monitor.js <PAGE_ID> cookie get "name"
node console-monitor.js <PAGE_ID> cookie delete "name"
```

### 存储操作：
```bash
# localStorage 操作
node console-monitor.js <PAGE_ID> storage list    # 列出所有项
node console-monitor.js <PAGE_ID> storage get "key"
node console-monitor.js <PAGE_ID> storage set "key" "value"
```

### 设备模拟：
```bash
# 移动设备模拟（默认 iPhone X）
node console-monitor.js <PAGE_ID> mobile

# 网络限速（单位：Kbps）
node console-monitor.js <PAGE_ID> network 1024    # 设置为 1Mbps
```

### 自动化测试：
```bash
# 表单操作
node console-monitor.js <PAGE_ID> type "text"     # 输入文本
node console-monitor.js <PAGE_ID> click 100 200   # 坐标点击

# 等待操作
node console-monitor.js <PAGE_ID> wait 2000       # 等待 2 秒
node console-monitor.js <PAGE_ID> wait-element "#id" 5000  # 等待元素最多 5 秒
```

### 性能分析：
```bash
# 开始性能分析
node console-monitor.js <PAGE_ID> profile start

# 停止并保存分析结果
node console-monitor.js <PAGE_ID> profile stop profile.json
```

### 安全功能：
- 自动脱敏密码和 token
- 支持自定义敏感字段
- HTTPS 证书处理
