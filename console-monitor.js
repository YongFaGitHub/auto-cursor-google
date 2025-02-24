import WebSocket from "ws"
import https from "https"
import http from "http"

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
  return process.argv[3] || LogLevel.NORMAL
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
  return new Promise((resolve, reject) => {
    http
      .get("http://localhost:9222/json/list", (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => {
          try {
            const pages = JSON.parse(data)
            resolve(pages)
          } catch (e) {
            reject(e)
          }
        })
      })
      .on("error", reject)
  })
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

// 主命令处理逻辑
async function executeCommand(ws, command, args) {
  try {
    await enableFeatures(ws)

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
    ]

    // 需要持续监听的命令列表
    const continuousCommands = ["wait", "wait-element", "profile", "type", "click"]

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
        const speed = parseInt(args[0]) || 1024
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
        const waitTime = parseInt(args[0]) || 1000
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
        const timeout = parseInt(args[1]) || 5000
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

      case "profile":
        if (args[0] === "start") {
          ws.send(
            JSON.stringify({
              id: 13,
              method: "Profiler.enable",
            })
          )
          ws.send(
            JSON.stringify({
              id: 14,
              method: "Profiler.start",
            })
          )
          console.log("性能分析已开始")
        } else if (args[0] === "stop") {
          ws.send(
            JSON.stringify({
              id: 15,
              method: "Profiler.stop",
            })
          )
          ws.once("message", (data) => {
            const message = JSON.parse(data)
            if (message.id === 15) {
              console.log("性能分析已完成")
              gracefulShutdown(ws)
            }
          })
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
        console.log("\n需要持续监听的命令：")
        console.log("- wait <ms>: 等待指定时间")
        console.log("- wait-element <selector> [timeout]: 等待元素出现")
        console.log("- profile start/stop: 性能分析")
        gracefulShutdown(ws, 1)
    }
  } catch (err) {
    console.error("命令执行错误:", err)
    gracefulShutdown(ws, 1)
  }
}

async function main() {
  const logLevel = getLogLevel()
  const command = process.argv[3] // 获取命令参数
  const commandArgs = process.argv.slice(4) // 获取命令参数

  console.log(`当前日志级别: ${logLevel}`)

  let ws
  let reconnectAttempts = 0
  const MAX_RECONNECT_ATTEMPTS = 3

  // 启动定时清理
  cleanupInterval = setInterval(cleanupRequestTimes, 10000)

  // 处理 Ctrl+C
  process.on("SIGINT", () => {
    console.log("\n收到退出信号...")
    isShuttingDown = true
    if (ws) {
      ws.terminate()
    }
    process.exit(0)
  })

  // 处理未捕获的异常
  process.on("uncaughtException", (err) => {
    console.error("未捕获的异常:", err)
    isShuttingDown = true
    if (ws) {
      ws.terminate()
    }
    process.exit(1)
  })

  // 处理未处理的Promise拒绝
  process.on("unhandledRejection", (reason, promise) => {
    console.error("未处理的Promise拒绝:", reason)
    isShuttingDown = true
    if (ws) {
      ws.terminate()
    }
    process.exit(1)
  })

  async function connectWebSocket() {
    try {
      const pages = await getAvailablePages()
      const pageId = process.argv[2]

      // 如果没有参数，列出所有页面
      if (!pageId) {
        console.log("可用页面列表:")
        pages.forEach((page) => {
          console.log(`\nID: ${page.id}`)
          console.log(`标题: ${page.title}`)
          console.log(`类型: ${page.type}`)
          console.log(`URL: ${page.url}`)
          console.log("---")
        })
        console.log("\n使用方法:")
        console.log("监控页面: node console-monitor.js <page-id> [mode]")
        console.log("页面操作: node console-monitor.js <page-id> <command> [args]")
        console.log("\n可用命令:")
        console.log("- goto <url>: 跳转到指定URL")
        console.log("- refresh: 刷新当前页面")
        console.log("\n日志级别 mode 可选值: open, normal, strict")
        process.exit(0)
      }

      let targetPage = pages.find((page) => page.id === pageId)
      if (!targetPage) {
        console.error(`未找到ID为 ${pageId} 的页面`)
        process.exit(1)
      }

      console.log(`已选择页面: ${targetPage.title} (${targetPage.url})`)

      ws = new WebSocket(targetPage.webSocketDebuggerUrl)

      ws.on("open", function open() {
        console.log(`已连接到页面 ${targetPage.id}`)
        reconnectAttempts = 0

        // 如果有命令，执行命令
        if (command) {
          executeCommand(ws, command, commandArgs).catch((err) => {
            console.error("命令执行错误:", err)
            gracefulShutdown(ws, 1)
          })
        }
      })

      ws.on("close", async function handleClose() {
        console.log("WebSocket connection closed")

        // 如果正在关闭，直接退出
        if (isShuttingDown) {
          process.exit(0)
        }

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++
          console.log(`Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`)
          await new Promise((resolve) => setTimeout(resolve, 2000)) // 等待2秒后重连
          connectWebSocket()
        } else {
          console.error("Max reconnection attempts reached")
          process.exit(1)
        }
      })

      ws.on("error", function error(err) {
        console.error("WebSocket error:", err)
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
            console.log(`[${logMessage.level}] ${logMessage.text}`)
          }
        }

        // Handle console API calls
        if (message.method === "Runtime.consoleAPICalled") {
          const logMessage = message.params
          const text = logMessage.args.map((arg) => arg.value).join(" ")
          if (isImportantLog(text, logMessage.type, logLevel)) {
            console.log(`[${logMessage.type}] ${text}`)
          }
        }

        // Handle network requests
        if (message.method === "Network.requestWillBeSent") {
          const request = message.params
          if (!shouldFilter(request.request.url, logLevel)) {
            requestTimes.set(request.requestId, Date.now())
            // 在normal和strict模式下不显示请求信息，只显示响应
            if (logLevel === LogLevel.OPEN) {
              console.log(`\n[Network Request] ${request.request.method} ${request.request.url}`)
              const params = formatRequestParams(request.request.url, request.request.postData)
              if (params) {
                console.log(`[Request Params]`, JSON.stringify(params, null, 2))
              }
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
              console.log(
                `[Network Response] ${response.response.status} ${response.response.statusText}${durationStr} - ${response.response.url}`
              )

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
              console.log("[Response Body]", formatResponseBody(body))
            }
          } catch (e) {
            // 忽略非JSON响应
          }
        }

        // Handle network errors
        if (message.method === "Network.loadingFailed") {
          const failure = message.params
          console.log(`[Network Error] Failed to load ${failure.requestId}: ${failure.errorText}`)
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
