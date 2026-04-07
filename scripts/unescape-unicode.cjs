#!/usr/bin/env node
/**
 * 将 esbuild 输出的 \uXXXX 转义序列还原为中文字符，增强构建产物可读性。
 * 仅处理字符串字面量内部的 \uXXXX（不破坏代码逻辑）。
 */
const fs = require('fs')
const path = require('path')

const libDir = path.resolve(__dirname, '..', 'lib')

for (const file of fs.readdirSync(libDir)) {
  if (!/\.(cjs|mjs|js)$/.test(file)) continue
  const filePath = path.join(libDir, file)
  const content = fs.readFileSync(filePath, 'utf8')
  // 匹配所有 \uXXXX 序列并还原为对应字符
  const result = content.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16))
  })
  if (result !== content) {
    fs.writeFileSync(filePath, result, 'utf8')
    console.log(`unescape-unicode: ${file} done`)
  }
}
