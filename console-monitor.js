import WebSocket from "ws"
import https from "https"
import http from "http"
import fs from "fs"
import path from "path"
import net from "net"
import os from "os"

// 日志级别枚举
const LogLevel = {
  OPEN: "open", // 不过滤任何信息
  NORMAL: "normal", // 过滤掉对日常调试开发没用的信息
  STRICT: "strict", // 只包含必要的信息
}

// 定义需要过滤的URL模式
const filterPatterns = {
  normal: [
    /\/__uno\.css/,
    /\/node_modules\//,
    /\.(css|scss|less)$/,
    /\.(png|jpg|jpeg|gif|svg|ico)$/,
    /hot-update/,
    /favicon/,
    /\/@vite/,
    /\/@fs/,
    /\[vite\]/,
    /\[hmr\]/,
    /\?v=\w+$/,
    /\?t=\d+$/,
    /\?vue&type=style/,
    /\.vite\/deps\//,
  ],
  strict: [
    /\/__uno\.css/,
    /\/node_modules\//,
    /\.(css|scss|less|js|ts|vue|png|jpg|jpeg|gif|svg|ico)$/,
    /hot-update/,
    /favicon/,
    /assets\//,
    /styles\//,
    /fonts\//,
    /\/@vite/,
    /\/@fs/,
    /\[vite\]/,
    /\[hmr\]/,
    /\?v=\w+$/,
    /\?t=\d+$/,
    /\?vue&type=style/,
    /\.vite\/deps\//,
  ],
}

// 定义重要的日志关键词
const importantKeywords = {
  normal: [
    "error",
    "warn",
    "info",
    "WebSocket",
    "订阅",
    "成功",
    "失败",
    "API",
    "异常",
    "超时",
    "权限",
  ],
  strict: ["error", "fail", "exception", "timeout", "失败", "异常", "超时", "权限拒绝"],
}

// 获取当前日志级别
function getLogLevel() {
  // 如果第四个参数是命令，而不是日志级别，则返回默认值
  const potentialLogLevel = process.argv[3];
  if (potentialLogLevel && ['open', 'normal', 'strict'].includes(potentialLogLevel)) {
    return potentialLogLevel;
  }
  return LogLevel.NORMAL;
}

// 获取Chrome调试端口
function getDebugPort() {
  // 首先检查是否有CHROME_DEBUG_PORT环境变量
  if (process.env.CHROME_DEBUG_PORT) {
    const port = parseInt(process.env.CHROME_DEBUG_PORT, 10);
    console.log(`使用CHROME_DEBUG_PORT环境变量指定的调试端口: ${port}`);
    return port;
  }
  
  // 获取随机端口
  function getRandomPort() {
    return 9000 + Math.floor(Math.random() * 1000);
  }
  
  // 同步检查端口是否可用
  function isPortAvailable(port) {
    try {
      const server = net.createServer();
      server.listen(port, '127.0.0.1', 0);
      server.close();
      return true; // 端口可用
    } catch (e) {
      console.log(`端口 ${port} 已被占用`);
      return false; // 端口被占用
    }
  }
  
  // 检查是否需要使用随机端口
  if (process.env.RANDOM_PORT === 'true') {
    // 尝试最多10次找到可用端口
    for (let i = 0; i < 10; i++) {
      const port = getRandomPort();
      if (isPortAvailable(port)) {
        console.log(`找到可用的调试端口: ${port}`);
        return port;
      }
    }
    
    // 如果找不到可用端口，默认使用9222
    console.log(`未找到可用端口，使用默认端口: 9222`);
    return 9222;
  } else {
    // 默认使用9222端口
    console.log(`使用固定调试端口: 9222`);
    return 9222;
  }
}

// 添加请求时间记录和清理机制
const requestTimes = new Map()
const REQUEST_TIMEOUT = 60000 // 60秒超时
let cleanupInterval

// 清理超时的请求记录
function cleanupRequestTimes() {
  const now = Date.now()
  for (const [requestId, startTime] of requestTimes.entries()) {
    if (now - startTime > REQUEST_TIMEOUT) {
      console.log(`[Warning] Request ${requestId} timed out`)
      requestTimes.delete(requestId)
    }
  }
}

// 添加退出状态标记
let isShuttingDown = false

// 优化优雅退出处理
async function gracefulShutdown(ws, exitCode = 0) {
  // 防止重复执行清理
  if (isShuttingDown) return
  isShuttingDown = true

  console.log("\n正在关闭监控...")

  try {
    // 清理定时器
    if (cleanupInterval) {
      clearInterval(cleanupInterval)
      cleanupInterval = null
    }

    // 清理请求记录
    requestTimes.clear()

    // 关闭WebSocket连接
    if (ws) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        // 先发送关闭命令
        try {
          ws.send(JSON.stringify({ method: "Network.disable" }))
          ws.send(JSON.stringify({ method: "Console.disable" }))
          ws.send(JSON.stringify({ method: "Runtime.disable" }))
        } catch (e) {
          // 忽略发送错误
        }

        // 立即终止连接，不等待重连
        ws.terminate()
      }
    }
  } catch (err) {
    console.error("清理过程出错:", err)
  } finally {
    // 强制退出进程，不等待重连
    process.exit(exitCode)
  }
}

// 格式化请求参数
function formatRequestParams(url, postData) {
  let params = {}

  // 处理URL参数
  try {
    const urlObj = new URL(url)
    urlObj.searchParams.forEach((value, key) => {
      params[key] = value
    })
  } catch (e) {}

  // 处理POST数据
  if (postData) {
    try {
      const postParams = JSON.parse(postData)
      params = { ...params, ...postParams }
    } catch (e) {
      try {
        // 处理 x-www-form-urlencoded 格式
        const searchParams = new URLSearchParams(postData)
        searchParams.forEach((value, key) => {
          params[key] = value
        })
      } catch (e) {}
    }
  }

  return Object.keys(params).length > 0 ? params : null
}

// 判断是否需要过滤的URL
function shouldFilter(url, logLevel) {
  if (logLevel === LogLevel.OPEN) return false

  // 在normal和strict模式下过滤node_modules相关请求
  if (logLevel !== LogLevel.OPEN && url.includes("node_modules")) {
    return true
  }

  const patterns = filterPatterns[logLevel] || filterPatterns.normal
  return patterns.some((pattern) => pattern.test(url))
}

// 判断是否是重要的日志消息
function isImportantLog(message, level, logLevel) {
  if (logLevel === LogLevel.OPEN) return true
  if (logLevel === LogLevel.NORMAL) {
    // 在normal模式下，始终显示info、warn和error级别的日志
    if (level && ["info", "warn", "error"].includes(level.toLowerCase())) {
      return true
    }
    const keywords = importantKeywords.normal
    return keywords.some((keyword) => message.toLowerCase().includes(keyword.toLowerCase()))
  }
  if (logLevel === LogLevel.STRICT) {
    const keywords = importantKeywords.strict
    return keywords.some((keyword) => message.toLowerCase().includes(keyword.toLowerCase()))
  }
  return false
}

// 判断是否是重要的响应
function isImportantResponse(body, logLevel) {
  if (logLevel === LogLevel.OPEN) return true
  if (logLevel === LogLevel.STRICT) {
    return body.code !== 200 || body.success === false || body.error
  }
  return body.code !== undefined || body.msg !== undefined || body.error
}

// 格式化响应内容
function formatResponseBody(body, maxLength = 10000) {
  // 深拷贝对象以避免修改原始数据
  const clone = JSON.parse(JSON.stringify(body))

  // 脱敏处理
  const sensitiveFields = ["password", "token", "secret", "key"]
  function maskSensitiveData(obj) {
    if (typeof obj !== "object" || obj === null) return
    Object.keys(obj).forEach((key) => {
      if (sensitiveFields.includes(key.toLowerCase())) {
        obj[key] = "******"
      } else if (typeof obj[key] === "object") {
        maskSensitiveData(obj[key])
      }
    })
  }
  maskSensitiveData(clone)

  // 转换为字符串并截断
  const str = JSON.stringify(clone, null, 2)
  if (str.length > maxLength) {
    return str.substring(0, maxLength) + "\n... (truncated)"
  }
  return str
}

async function getAvailablePages() {
  const debugPort = getDebugPort();
  console.log(`正在获取Chrome调试页面列表，端口: ${debugPort}`);
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${debugPort}/json/list`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const pages = JSON.parse(data);
            console.log(`成功获取到 ${pages.length} 个页面`);
            pages.forEach((page, index) => {
              console.log(`页面 ${index+1}/${pages.length}:`);
              console.log(`- ID: ${page.id}`);
              console.log(`- 标题: ${page.title}`);
              console.log(`- URL: ${page.url.substring(0, 100)}${page.url.length > 100 ? '...' : ''}`);
              console.log(`- WebSocket URL: ${page.webSocketDebuggerUrl || '无'}`);
            });
            resolve(pages);
          } catch (e) {
            console.error(`解析页面列表失败: ${e.message}`);
            reject(e);
          }
        });
      })
      .on("error", (err) => {
        console.error(`获取页面列表出错: ${err.message}`);
        console.error(`确保Chrome在端口 ${debugPort} 上启用了远程调试`);
        reject(err);
      });
  });
}

// 确保在发送命令前启用所需功能
async function enableFeatures(ws) {
  return new Promise((resolve) => {
    let enabledCount = 0
    const requiredFeatures = ["Console", "Runtime", "Network", "Page"]

    requiredFeatures.forEach((feature, index) => {
      ws.send(
        JSON.stringify({
          id: 100 + index,
          method: `${feature}.enable`,
        })
      )
    })

    const checkEnabled = (data) => {
      try {
        const message = JSON.parse(data)
        if (message.id >= 100 && message.id < 100 + requiredFeatures.length) {
          enabledCount++
          if (enabledCount === requiredFeatures.length) {
            ws.removeListener("message", checkEnabled)
            resolve()
          }
        }
      } catch (err) {
        console.error("启用功能时出错:", err)
      }
    }

    ws.on("message", checkEnabled)
  })
}

// 通用消息处理函数
function handleResponse(ws, data, expectedId) {
  try {
    const message = JSON.parse(data)
    console.log("收到消息:", JSON.stringify(message))

    // 检查是否是预期的响应
    if (message.id === expectedId) {
      if (message.error) {
        console.error("操作失败:", message.error)
        return gracefulShutdown(ws, 1)
      }
      if (message.result !== undefined) {
        console.log("操作成功:", message.result)
        return gracefulShutdown(ws)
      }
    }

    // 检查是否是页面事件
    if (message.method === "Page.loadEventFired") {
      console.log("页面加载完成")
      return gracefulShutdown(ws)
    }
  } catch (err) {
    console.error("消息处理错误:", err)
  }
}

// 日志输出函数
function logWithTimestamp(message) {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] ${message}`);
}

// 主命令处理逻辑
async function executeCommand(ws, command, args, targetPage) {
  try {
    await enableFeatures(ws).then(() => {
      console.log("控制台和网络监控功能已启用");
    });

    // 一次性操作命令列表
    const oneTimeCommands = [
      "goto",
      "refresh",
      "element-click",
      "get-text",
      "cookie",
      "storage",
      "mobile",
      "network",
      "type",
      "click",
      "scroll-to",
      "screenshot"
    ]

    // 需要持续监听的命令列表
    const continuousCommands = ["wait", "wait-element"]

    // 如果是一次性操作命令，设置超时保护
    if (oneTimeCommands.includes(command)) {
      setTimeout(() => {
        console.log("操作超时，自动退出")
        gracefulShutdown(ws, 1)
      }, 30000) // 30秒超时
    }

    switch (command) {
      case "cookie":
        const cookieId = 8
        switch (args[0]) {
          case "list":
            ws.send(
              JSON.stringify({
                id: cookieId,
                method: "Network.getAllCookies",
              })
            )
            break
          case "set":
            if (!args[1] || !args[2]) {
              console.error("请提供cookie名称和值")
              return gracefulShutdown(ws, 1)
            }
            ws.send(
              JSON.stringify({
                id: cookieId,
                method: "Network.setCookie",
                params: {
                  name: args[1],
                  value: args[2],
                  url: targetPage.url,
                },
              })
            )
            break
          case "get":
            if (!args[1]) {
              console.error("请提供cookie名称")
              return gracefulShutdown(ws, 1)
            }
            ws.send(
              JSON.stringify({
                id: cookieId,
                method: "Network.getCookies",
                params: { urls: [targetPage.url] },
              })
            )
            break
          case "delete":
            if (!args[1]) {
              console.error("请提供要删除的cookie名称")
              return gracefulShutdown(ws, 1)
            }
            ws.send(
              JSON.stringify({
                id: cookieId,
                method: "Network.deleteCookies",
                params: { name: args[1], url: targetPage.url },
              })
            )
            break
          default:
            console.error("未知的cookie操作")
            return gracefulShutdown(ws, 1)
        }
        ws.on("message", (data) => handleResponse(ws, data, cookieId))
        break

      case "storage":
        const storageId = 9
        switch (args[0]) {
          case "list":
            ws.send(
              JSON.stringify({
                id: storageId,
                method: "Runtime.evaluate",
                params: {
                  expression: "JSON.stringify(Object.entries(localStorage))",
                  returnByValue: true,
                },
              })
            )
            break
          case "set":
            if (!args[1] || !args[2]) {
              console.error("请提供storage的key和value")
              return gracefulShutdown(ws, 1)
            }
            ws.send(
              JSON.stringify({
                id: storageId,
                method: "Runtime.evaluate",
                params: {
                  expression: `localStorage.setItem('${args[1]}', '${args[2]}')`,
                },
              })
            )
            break
          case "get":
            if (!args[1]) {
              console.error("请提供storage的key")
              return gracefulShutdown(ws, 1)
            }
            ws.send(
              JSON.stringify({
                id: storageId,
                method: "Runtime.evaluate",
                params: {
                  expression: `localStorage.getItem('${args[1]}')`,
                },
              })
            )
            break
          default:
            console.error("未知的storage操作")
            return gracefulShutdown(ws, 1)
        }
        ws.on("message", (data) => handleResponse(ws, data, storageId))
        break

      case "goto":
        if (!args[0]) {
          console.error("请提供要跳转的URL")
          return gracefulShutdown(ws, 1)
        }
        ws.send(
          JSON.stringify({
            id: 4,
            method: "Page.navigate",
            params: { url: args[0] },
          })
        )
        console.log(`正在跳转到: ${args[0]}`)
        ws.on("message", (data) => handleResponse(ws, data, 4))
        break

      case "refresh":
        ws.send(
          JSON.stringify({
            id: 5,
            method: "Page.reload",
            params: { ignoreCache: true },
          })
        )
        console.log("正在刷新页面...")
        ws.on("message", (data) => handleResponse(ws, data, 5))
        break

      case "element-click":
        if (!args[0]) {
          console.error("请提供要点击的元素选择器")
          return gracefulShutdown(ws, 1)
        }
        ws.send(
          JSON.stringify({
            id: 6,
            method: "Runtime.evaluate",
            params: {
              expression: `
                (function() {
                  const element = document.querySelector('${args[0]}');
                  if (!element) {
                    return { error: '元素不存在' };
                  }
                  element.click();
                  return { success: true };
                })()
              `,
              returnByValue: true,
            },
          })
        )
        // 等待点击操作完成后退出
        ws.once("message", (data) => {
          const message = JSON.parse(data)
          if (message.id === 6) {
            if (message.result && message.result.result) {
              const result = message.result.result
              if (result.error) {
                console.error(result.error)
                gracefulShutdown(ws, 1)
              } else {
                console.log("点击操作成功")
                gracefulShutdown(ws)
              }
            }
          }
        })
        break

      case "get-text":
        if (!args[0]) {
          console.error("请提供要获取文本的元素选择器")
          return gracefulShutdown(ws, 1)
        }
        ws.send(
          JSON.stringify({
            id: 7,
            method: "Runtime.evaluate",
            params: {
              expression: `document.querySelector('${args[0]}').textContent`,
            },
          })
        )
        // 等待获取文本完成后退出
        ws.once("message", (data) => {
          const message = JSON.parse(data)
          if (message.id === 7) {
            if (message.result && message.result.result) {
              console.log("文本内容:", message.result.result.value)
            }
            gracefulShutdown(ws)
          }
        })
        break

      case "mobile":
        ws.send(
          JSON.stringify({
            id: 10,
            method: "Emulation.setDeviceMetricsOverride",
            params: {
              width: 375,
              height: 812,
              deviceScaleFactor: 3,
              mobile: true,
            },
          })
        )
        // 等待设备模拟设置完成后退出
        ws.once("message", (data) => {
          const message = JSON.parse(data)
          if (message.id === 10) {
            if (message.error) {
              console.error("设备模拟设置失败:", message.error)
              gracefulShutdown(ws, 1)
            } else {
              console.log("移动设备模拟已启用")
              gracefulShutdown(ws)
            }
          }
        })
        break

      case "network":
        // 处理可能带前缀的参数
        const speedArg = args[0] ? args[0].replace(/^arg_/, '') : '1024';
        const speed = parseInt(speedArg) || 1024
        ws.send(
          JSON.stringify({
            id: 11,
            method: "Network.emulateNetworkConditions",
            params: {
              offline: false,
              latency: 100,
              downloadThroughput: (speed * 1024) / 8,
              uploadThroughput: (speed * 1024) / 8,
            },
          })
        )
        // 等待网络限速设置完成后退出
        ws.once("message", (data) => {
          const message = JSON.parse(data)
          if (message.id === 11) {
            console.log(`网络限速已设置为 ${speed}Kbps`)
            gracefulShutdown(ws)
          }
        })
        break

      case "wait":
        // 处理可能带前缀的参数
        const waitTimeArg = args[0] ? args[0].replace(/^arg_/, '') : '1000';
        const waitTime = parseInt(waitTimeArg) || 1000
        setTimeout(() => {
          console.log(`等待 ${waitTime}ms 完成`)
          gracefulShutdown(ws)
        }, waitTime)
        break

      case "wait-element":
        if (!args[0]) {
          console.error("请提供要等待的元素选择器")
          return gracefulShutdown(ws, 1)
        }
        // 处理可能带前缀的参数
        const timeoutArg = args[1] ? args[1].replace(/^arg_/, '') : '5000';
        const timeout = parseInt(timeoutArg) || 5000
        const checkInterval = setInterval(() => {
          ws.send(
            JSON.stringify({
              id: 12,
              method: "Runtime.evaluate",
              params: {
                expression: `document.querySelector('${args[0]}') !== null`,
              },
            })
          )
        }, 100)

        // 设置超时
        setTimeout(() => {
          clearInterval(checkInterval)
          console.error(`等待元素 ${args[0]} 超时`)
          gracefulShutdown(ws, 1)
        }, timeout)

        // 检查元素是否存在
        ws.on("message", (data) => {
          const message = JSON.parse(data)
          if (message.id === 12 && message.result && message.result.result) {
            if (message.result.result.value === true) {
              clearInterval(checkInterval)
              console.log(`元素 ${args[0]} 已出现`)
              gracefulShutdown(ws)
            }
          }
        })
        break

      case "scroll-to":
        if (!args[0]) {
          console.error("请提供元素选择器或坐标")
          return gracefulShutdown(ws, 1)
        }
        
        // 检查是否是坐标格式 (x,y)
        const isCoordinate = args[0].match(/^\d+,\d+$/);
        
        let expression;
        if (isCoordinate) {
          const [x, y] = args[0].split(',').map(Number);
          expression = `
            (function() {
              window.scrollTo({
                left: ${x},
                top: ${y},
                behavior: 'smooth'
              });
              return { success: true, message: '已滚动到坐标 (${x}, ${y})' };
            })()
          `;
        } else {
          // 假设是元素选择器
          expression = `
            (function() {
              const element = document.querySelector('${args[0]}');
              if (!element) {
                return { error: '元素不存在' };
              }
              
              // 获取元素位置
              const rect = element.getBoundingClientRect();
              const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
              const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
              
              // 计算元素的绝对位置
              const top = rect.top + scrollTop;
              const left = rect.left + scrollLeft;
              
              // 滚动到元素位置
              element.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
                inline: 'center'
              });
              
              return { success: true, message: '已滚动到指定元素' };
            })()
          `;
        }
        
        ws.send(
          JSON.stringify({
            id: 22,
            method: "Runtime.evaluate",
            params: {
              expression,
              returnByValue: true,
            },
          })
        );
        
        // 等待滚动操作完成后处理结果
        ws.once("message", (data) => {
          const message = JSON.parse(data);
          if (message.id === 22) {
            if (message.result && message.result.result) {
              const result = message.result.result;
              if (result.error) {
                console.error(result.error);
                gracefulShutdown(ws, 1);
              } else {
                console.log(result.message || "滚动操作成功");
                gracefulShutdown(ws);
              }
            }
          }
        });
        break

      case "screenshot":
        // 设置默认文件名和保存路径
        const screenshotDir = args[0] || "./screenshots"
        let filename = args[1] || `screenshot_${new Date().toISOString().replace(/[:.]/g, "-")}`
        // 确保文件名有.png扩展名
        if (!filename.toLowerCase().endsWith('.png')) {
          filename += '.png'
        }
        const fullPath = path.join(screenshotDir, filename)
        
        // 确保目录存在
        try {
          if (!fs.existsSync(screenshotDir)) {
            fs.mkdirSync(screenshotDir, { recursive: true })
          }
        } catch (err) {
          console.error(`创建截图目录失败: ${err.message}`)
          return gracefulShutdown(ws, 1)
        }
        
        console.log(`正在捕获截图，保存到: ${fullPath}`)
        
        // 捕获截图
        ws.send(
          JSON.stringify({
            id: 23,
            method: "Page.captureScreenshot",
            params: {
              format: "png",
              quality: 100,
              fromSurface: true,
              captureBeyondViewport: true
            }
          })
        )
        
        // 处理截图结果
        let screenshotTimeout = setTimeout(() => {
          console.error("截图超时")
          gracefulShutdown(ws, 1)
        }, 10000) // 10秒超时
        
        // 定义处理函数
        const handleScreenshotResponse = function(data) {
          clearTimeout(screenshotTimeout) // 清除超时定时器
          try {
            const message = JSON.parse(data)
            if (message.id === 23) {
              if (message.result && message.result.data) {
                try {
                  // 将 Base64 数据写入文件
                  const imageBuffer = Buffer.from(message.result.data, "base64")
                  fs.writeFileSync(fullPath, imageBuffer)
                  console.log(`截图已保存到: ${fullPath}`)
                  gracefulShutdown(ws)
                } catch (err) {
                  console.error(`保存截图失败: ${err.message}`)
                  gracefulShutdown(ws, 1)
                }
              } else if (message.error) {
                console.error(`截图失败: ${message.error.message || JSON.stringify(message.error)}`)
                gracefulShutdown(ws, 1)
              } else {
                console.error("截图响应无效: 缺少数据")
                gracefulShutdown(ws, 1)
              }
            } else {
              // 如果不是我们期望的响应ID，继续等待正确的响应
              ws.once("message", handleScreenshotResponse)
            }
          } catch (err) {
            console.error(`处理截图响应出错: ${err.message}`)
            gracefulShutdown(ws, 1)
          }
        };
        
        ws.once("message", handleScreenshotResponse)
        break

      case "type":
        if (!args[0] || !args[1]) {
          console.error("请提供要输入文本的元素选择器和文本")
          return gracefulShutdown(ws, 1)
        }
        ws.send(
          JSON.stringify({
            id: 24,
            method: "Runtime.evaluate",
            params: {
              expression: `
                (function() {
                  const element = document.querySelector('${args[0]}');
                  if (!element) {
                    return { error: '元素不存在' };
                  }
                  element.value = '${args[1]}';
                  return { success: true };
                })()
              `,
              returnByValue: true,
            },
          })
        )
        // 等待输入完成
        ws.once("message", (data) => {
          const message = JSON.parse(data)
          if (message.id === 24) {
            if (message.result && message.result.result) {
              console.log("文本输入成功")
              gracefulShutdown(ws)
            } else if (message.error) {
              console.error(message.error.message)
              gracefulShutdown(ws, 1)
            }
          }
        })
        break

      case "click":
        if (!args[0] || !args[1]) {
          console.error("请提供要点击的坐标");
          return gracefulShutdown(ws, 1);
        }
        
        // 处理可能带前缀的参数
        let xRaw = args[0];
        let yRaw = args[1];
        
        const xStr = xRaw.replace(/^arg_/, '');
        const yStr = yRaw.replace(/^arg_/, '');
        
        const x = parseInt(xStr, 10);
        const y = parseInt(yStr, 10);
        
        if (isNaN(x) || isNaN(y)) {
          console.error("坐标必须是有效的数字");
          return gracefulShutdown(ws, 1);
        }
        
        console.log(`准备点击坐标: (${x}, ${y})`);
        
        try {
          ws.send(
            JSON.stringify({
              id: 25,
              method: "Emulation.setTouchEmulationEnabled",
              params: {
                enabled: true,
                configuration: "mobile",
              },
            })
          );
          
          // 创建一个Promise来等待触摸模拟命令的响应
          const touchEmulationPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error("触摸模拟命令响应超时"));
            }, 5000);
            
            const handleResponse = (data) => {
              try {
                const message = JSON.parse(data);
                
                if (message.id === 25) {
                  clearTimeout(timeout);
                  ws.removeListener("message", handleResponse);
                  
                  if (message.error) {
                    reject(new Error(`触摸模拟启用失败: ${message.error.message}`));
                  } else {
                    resolve();
                  }
                }
              } catch (err) {
                console.error(`解析触摸模拟响应出错: ${err.message}`);
              }
            };
            
            ws.on("message", handleResponse);
          });
          
          // 等待触摸模拟命令完成，然后发送点击命令
          touchEmulationPromise.then(() => {
            ws.send(
              JSON.stringify({
                id: 26,
                method: "Input.dispatchMouseEvent",  // 改用Mouse事件替代Emulation.tap
                params: {
                  type: "mousePressed",
                  x: x,
                  y: y,
                  button: "left",
                  clickCount: 1
                },
              })
            );
            
            // 然后发送mouseReleased事件完成点击
            setTimeout(() => {
              ws.send(
                JSON.stringify({
                  id: 27,
                  method: "Input.dispatchMouseEvent",
                  params: {
                    type: "mouseReleased",
                    x: x,
                    y: y,
                    button: "left",
                    clickCount: 1
                  },
                })
              );
            }, 100);
            
            // 设置一个较短的超时，用于点击命令的响应
            let clickTimeout = setTimeout(() => {
              console.log("点击命令响应超时，但操作可能已成功");
              gracefulShutdown(ws, 0); // 超时但返回成功状态
            }, 5000);
            
            // 监听所有消息
            const allMessageHandler = (data) => {
              try {
                const message = JSON.parse(data);
                
                if (message.id === 26 || message.id === 27) {
                  if (message.id === 27) { // 只有当mouseReleased响应到达时才清理
                    clearTimeout(clickTimeout);
                    ws.removeListener("message", allMessageHandler);
                    console.log("点击操作成功完成");
                    gracefulShutdown(ws, 0);
                  }
                }
              } catch (err) {
                console.error(`解析消息出错: ${err.message}`);
              }
            };
            
            ws.on("message", allMessageHandler);
          }).catch(err => {
            console.error(`点击操作失败: ${err.message}`);
            gracefulShutdown(ws, 1);
          });
          
        } catch (err) {
          console.error(`发送点击命令时出错: ${err.message}`);
          if (err.stack) console.error(`错误堆栈: ${err.stack}`);
          return gracefulShutdown(ws, 1);
        }
        break

      default:
        console.log("未知命令。可用命令：")
        console.log("一次性操作命令：")
        console.log("- goto <url>: 跳转到指定URL")
        console.log("- refresh: 刷新当前页面")
        console.log("- element-click <selector>: 点击元素")
        console.log("- get-text <selector>: 获取元素文本")
        console.log("- cookie list/set/get/delete: Cookie操作")
        console.log("- storage list/set/get: Storage操作")
        console.log("- mobile: 移动设备模拟")
        console.log("- network <speed>: 网络限速(Kbps)")
        console.log("- scroll-to <selector|x,y>: 滚动到指定元素或坐标")
        console.log("- screenshot <dir> <filename>: 捕获当前页面截图")
        console.log("- type <selector> <text>: 在元素中输入文本")
        console.log("- click <x> <y>: 在指定坐标点击")
        console.log("\n需要持续监听的命令：")
        console.log("- wait <ms>: 等待指定时间")
        console.log("- wait-element <selector> [timeout]: 等待元素出现")
        console.log("\n日志级别 mode 可选值: open, normal, strict")
        gracefulShutdown(ws, 1)
    }
  } catch (err) {
    console.error("命令执行错误:", err)
    gracefulShutdown(ws, 1)
  }
}

// 辅助函数: 将WebSocket readyState转换为可读字符串
function getReadyStateString(readyState) {
  switch(readyState) {
    case WebSocket.CONNECTING: return 'CONNECTING';
    case WebSocket.OPEN: return 'OPEN';
    case WebSocket.CLOSING: return 'CLOSING';
    case WebSocket.CLOSED: return 'CLOSED';
    default: return `UNKNOWN(${readyState})`;
  }
}

async function main() {
  // 先打印原始参数
  console.log(`原始命令行参数:`, process.argv);
  
  // 检查是否是help命令
  if (process.argv[2] === 'help') {
    console.log("可用命令：")
    console.log("一次性操作命令：")
    console.log("- goto <url>: 跳转到指定URL")
    console.log("- refresh: 刷新当前页面")
    console.log("- element-click <selector>: 点击元素")
    console.log("- get-text <selector>: 获取元素文本")
    console.log("- cookie list/set/get/delete: Cookie操作")
    console.log("- storage list/set/get: Storage操作")
    console.log("- mobile: 移动设备模拟")
    console.log("- network <speed>: 网络限速(Kbps)")
    console.log("- scroll-to <selector|x,y>: 滚动到指定元素或坐标")
    console.log("- screenshot <dir> <filename>: 捕获当前页面截图")
    console.log("- type <selector> <text>: 在元素中输入文本")
    console.log("- click <x> <y>: 在指定坐标点击")
    console.log("\n需要持续监听的命令：")
    console.log("- wait <ms>: 等待指定时间")
    console.log("- wait-element <selector> [timeout]: 等待元素出现")
    console.log("\n实用功能命令：")
    console.log("- help: 显示此帮助信息")
    console.log("- list-pages: 列出当前可用的所有Chrome调试页面")
    console.log("\n日志级别 mode 可选值: open, normal, strict")
    console.log("\n环境变量配置：")
    console.log("- CHROME_DEBUG_PORT=<port>: 指定Chrome调试端口（默认9222）")
    console.log("- RANDOM_PORT=true: 启用随机端口选择以避免端口冲突")
    console.log("- PAGE_ID=<id>: 预设页面ID，避免命令行传参")
    console.log("\n多项目并行使用：")
    console.log("1. 为不同项目指定不同端口: CHROME_DEBUG_PORT=9223 npm run dev")
    console.log("2. 使用随机端口避免冲突: RANDOM_PORT=true npm run dev")
    console.log("3. 通过页面ID直接操作: PAGE_ID=<id> node console-monitor.js <command>")
    console.log("\n使用方法:")
    console.log("node console-monitor.js <页面ID> <命令> [参数...]")
    console.log("示例: node console-monitor.js AB12CD34 goto https://example.com")
    console.log("或使用环境变量: PAGE_ID=AB12CD34 node console-monitor.js goto https://example.com")
    process.exit(0);
  }
  
  // 检查是否是list-pages命令
  if (process.argv[2] === 'list-pages') {
    try {
      const debugPort = getDebugPort();
      console.log(`使用调试端口: ${debugPort}`);
      
      const pages = await getAvailablePages(debugPort);
      console.log(`找到 ${pages.length} 个可用页面:`);
      
      pages.forEach((page, index) => {
        console.log(`\n页面 ${index + 1}:`);
        console.log(`- ID: ${page.id}`);
        console.log(`- 标题: ${page.title}`);
        console.log(`- URL: ${page.url}`);
        console.log(`- 类型: ${page.type}`);
      });
      
      process.exit(0);
    } catch (err) {
      console.error(`获取页面列表失败: ${err.message}`);
      process.exit(1);
    }
  }
  
  let pageId = process.env.PAGE_ID || process.argv[2]
  if (!pageId) {
    console.error("请提供页面ID作为第一个参数，或设置PAGE_ID环境变量")
    console.log("获取可用页面ID，请运行: node console-monitor.js list-pages")
    process.exit(1)
  }
  
  // 警告: 如果页面ID以数字开头，提示可能会出现连接问题
  if (/^\d/.test(pageId)) {
    console.warn("警告: 页面ID以数字开头，可能会导致连接问题");
    console.warn("建议使用以字母开头的ID或使用PAGE_ID环境变量");
  }
  
  const potentialLogLevel = process.argv[3];
  let logLevel, command, commandArgs;
  
  if (potentialLogLevel && ['open', 'normal', 'strict'].includes(potentialLogLevel)) {
    // 如果是日志级别，那么没有命令
    logLevel = potentialLogLevel;
    command = null;
    commandArgs = [];
  } else {
    // 否则第三个参数是命令
    logLevel = LogLevel.NORMAL;
    command = process.argv[3];
    
    // 明确地从第4个参数开始收集所有命令参数，避免与其他配置混淆
    commandArgs = [];
    if (process.argv.length > 4) {
      // 对于纯数字参数，添加前缀，避免被错误解析为端口
      commandArgs = process.argv.slice(4).map(arg => {
        // 如果参数是纯数字，添加前缀"arg_"
        if (/^\d+$/.test(arg)) {
          const prefixedArg = `arg_${arg}`;
          return prefixedArg;
        }
        return arg;
      });
    }
  }

  console.log(`当前日志级别: ${logLevel}`);
  console.log(`页面ID: "${pageId}"`);
  console.log(`命令: "${command || "无"}"`);
  console.log(`命令参数: [${commandArgs.length ? commandArgs.join(', ') : "无"}]`);

  let ws;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;

  // 启动定时清理
  cleanupInterval = setInterval(cleanupRequestTimes, 10000);

  // 处理 Ctrl+C
  process.on("SIGINT", () => {
    console.log("\n收到退出信号...");
    isShuttingDown = true;
    if (ws) {
      ws.terminate();
    }
    process.exit(0);
  });

  // 处理未捕获的异常
  process.on("uncaughtException", (err) => {
    console.error("未捕获的异常:", err);
    isShuttingDown = true;
    if (ws) {
      ws.terminate();
    }
    process.exit(1);
  });

  // 处理未处理的Promise拒绝
  process.on("unhandledRejection", (reason, promise) => {
    console.error("未处理的Promise拒绝:", reason);
    isShuttingDown = true;
    if (ws) {
      ws.terminate();
    }
    process.exit(1);
  });

  async function connectWebSocket() {
    try {
      console.log(`开始连接到页面ID: "${pageId}"`);
      
      const pages = await getAvailablePages();
      console.log(`正在查找目标页面...`);

      let targetPage = pages.find((page) => page.id === pageId);
      if (!targetPage) {
        console.error(`未找到ID为 "${pageId}" 的页面`);
        console.log(`可用页面ID列表:`);
        pages.forEach(page => console.log(`- ${page.id}: ${page.title}`));
        process.exit(1);
      }

      console.log(`已选择页面: ${targetPage.title} (${targetPage.url})`);

      // 确保WebSocket URL正确无误，不受命令参数影响
      const wsUrl = targetPage.webSocketDebuggerUrl;
      if (!wsUrl) {
        console.error(`页面 ${pageId} 没有有效的WebSocket URL`);
        process.exit(1);
      }
      
      console.log(`准备连接到WebSocket URL: ${wsUrl}`);
      
      try {
        ws = new WebSocket(wsUrl, {
          handshakeTimeout: 5000, // 5秒超时
          maxPayload: 50 * 1024 * 1024 // 50MB最大负载
        });
      } catch (err) {
        console.error(`WebSocket连接初始化失败: ${err.message}`);
        process.exit(1);
      }

      ws.on("open", function open() {
        console.log(`已成功连接到页面 ${targetPage.id}`);
        reconnectAttempts = 0;
        // Enable console API
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Console.enable",
          })
        );

        // Enable runtime
        ws.send(
          JSON.stringify({
            id: 2,
            method: "Runtime.enable",
          })
        );

        // Enable network monitoring
        ws.send(
          JSON.stringify({
            id: 3,
            method: "Network.enable",
          })
        );
        // // 如果有命令，执行命令
        // if (command) {
        //   console.log(`准备执行命令: "${command}", 参数: [${commandArgs.join(', ')}]`);
        //   executeCommand(ws, command, commandArgs, targetPage).catch((err) => {
        //     console.error(`命令执行错误: ${err.message}`);
        //     gracefulShutdown(ws, 1);
        //   });
       // }
      });

      ws.on("close", async function handleClose() {
        console.log("WebSocket连接已关闭")

        // 如果正在关闭，直接退出
        if (isShuttingDown) {
          process.exit(0)
        }

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++
          console.log(`尝试重新连接 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`)
          await new Promise((resolve) => setTimeout(resolve, 2000)) // 等待2秒后重连
          connectWebSocket()
        } else {
          console.error("已达到最大重连尝试次数，开始关闭监控")
          gracefulShutdown(ws)
        }
      })

      ws.on("error", function error(err) {
        console.error("WebSocket错误:", err.message)
        if (ws.readyState === WebSocket.OPEN) {
          ws.close()
        }
        if (isShuttingDown) {
          process.exit(1)
        }
      })

      ws.on("message", function incoming(data) {
        const message = JSON.parse(data)

        // Handle console messages
        if (message.method === "Console.messageAdded") {
          const logMessage = message.params.message
          if (isImportantLog(logMessage.text, logMessage.level, logLevel)) {
            console.log(`\n[${logMessage.level}] ${logMessage.text}`)
          }
        }

        // Handle console API calls
        if (message.method === "Runtime.consoleAPICalled") {
          const logMessage = message.params
          const text = logMessage.args.map((arg) => arg.value).join(" ")
          if (isImportantLog(text, logMessage.type, logLevel)) {
            console.log(`\n[${logMessage.type}] ${text}`)
          }
        }

        // Handle network requests
        if (message.method === "Network.requestWillBeSent") {
          const request = message.params
          if (!shouldFilter(request.request.url, logLevel)) {
            requestTimes.set(request.requestId, Date.now())
            // 在normal和strict模式下不显示请求信息，只显示响应
            if (logLevel === LogLevel.OPEN) {
              const params = formatRequestParams(request.request.url, request.request.postData)
              logWithTimestamp(`\n[Network Request] ${request.request.method} ${request.request.url} - Params: ${JSON.stringify(params)}`)
            }
          }
        }

        // Handle network responses
        if (message.method === "Network.responseReceived") {
          const response = message.params
          if (!shouldFilter(response.response.url, logLevel)) {
            const startTime = requestTimes.get(response.requestId)
            const duration = startTime ? Date.now() - startTime : null
            const durationStr = duration ? ` (${duration}ms)` : ""

            // 只有在状态码不是200或者是API请求时才显示响应信息
            const isApiRequest =
              response.response.url.includes("/api/") || response.response.url.includes("/dev-api/")
            const isNonSuccessResponse = response.response.status !== 200

            if (isApiRequest || isNonSuccessResponse) {
              logWithTimestamp(`\n[Network Response] ${response.response.status} ${response.response.statusText}${durationStr} - URL: ${response.response.url}`)

              if (response.response.mimeType === "application/json") {
                ws.send(
                  JSON.stringify({
                    id: 4,
                    method: "Network.getResponseBody",
                    params: { requestId: response.requestId },
                  })
                )
              }
            }
            requestTimes.delete(response.requestId)
          }
        }

        // Handle response body
        if (message.id === 4 && message.result) {
          try {
            const body = JSON.parse(message.result.body)
            if (isImportantResponse(body, logLevel)) {
              logWithTimestamp("\n[Response Body] " + formatResponseBody(body))
            }
          } catch (e) {
            logWithTimestamp("\n[Response Body] " + message.result.body)
          }
        }

        // Handle network errors
        if (message.method === "Network.loadingFailed") {
          const failure = message.params
          logWithTimestamp(`\n[Network Error] Failed to load ${failure.requestId}: ${failure.errorText}`)
        }
      })
    } catch (err) {
      console.error("Connection error:", err)
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++
        console.log(`Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`)
        await new Promise((resolve) => setTimeout(resolve, 2000))
        connectWebSocket()
      } else {
        console.error("Max reconnection attempts reached")
        gracefulShutdown(ws)
      }
    }
  }

  // 启动连接
  await connectWebSocket()

  console.log("Monitoring console logs and network activity... Press Ctrl+C to stop.")
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
