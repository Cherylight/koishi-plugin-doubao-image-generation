export default {
  commands: {
    gen: {
      description: '图片生成（文生图/图生图）',
      messages: {
        'gen-no-input': '请输入提示词或附带图片，例如：gen 一只在月球上散步的橘猫',
        'gen-working': '正在按照你的需求生成图片…',
      },
    },
    'gen-switch': {
      description: '图片生成功能开关',
      options: {
        t2i: '文生图开关 (on/off)',
        i2i: '图生图开关 (on/off)',
      },
      messages: {
        'gen-switch-status': '当前频道图片生成状态：\n文生图：{t2i}\n图生图：{i2i}',
        'gen-switch-invalid': '请使用 on 或 off，例如 gen-switch --t2i on',
        'gen-switch-updated': '已更新图片生成开关：\n文生图：{t2i}\n图生图：{i2i}',
      },
    },
    'gen-append': {
      description: '追加图片生成上下文（引用消息或直接输入）',
      messages: {
        'gen-append-empty': '请引用一条消息或附带内容。用法：引用一条消息并发送 gen-append，或 gen-append [文字/图片]',
        'gen-append-success': '已追加到上下文，当前共 {textCount} 段文字、{imageCount} 张图片。\n上下文将在 60 秒内有效，使用 gen-ctx -s 发送请求。',
        'gen-context-expired': '你的图片生成上下文已过期，如需继续请重新追加。',
      },
    },
    'gen-ctx': {
      description: '管理图片生成上下文',
      options: {
        clear: '清空当前上下文',
        send: '以当前上下文发送生成请求',
      },
      messages: {
        'gen-ctx-empty': '当前没有待处理的上下文。使用 gen-append 添加内容。',
        'gen-ctx-cleared': '上下文已清空。',
        'gen-ctx-info': '当前上下文：{textCount} 段文字、{imageCount} 张图片\n剩余有效时间：{remaining} 秒\n使用 gen-ctx -s 发送请求，gen-ctx -c 清空',
        'gen-ctx-no-prompt': '上下文中没有文字描述，无法生成图片。请先用 gen-append 添加提示词。',
      },
    },
  },
}
