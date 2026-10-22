# dsh-quote

给 DSH（DeepSeek Harness）的每条回答加一个「引用」按钮：点击后把这条回答的**完整正文**以 `> 引用块` 的形式预填进输入框，方便针对某条回答继续追问。

## 功能

- 每条回答的操作行（复制 / 点赞那一排）里有双引号图标
- 点击后：
  - 输入框**上方**出现引用条：灰底、左侧竖线、前 100 字摘要、右侧 ×
  - 输入框预填 `> 完整回答全文`
- 按 Enter 或点发送后，引用条当帧消失
- 点 × 可取消引用

## 安装

通过 DSH 的 profile 插件机制安装：

```powershell
dsh plugin --profile desktop add link:D:\path\to\dsh-quote
```

安装后重启 DSH。`dsh plugin` 会把包写进 profile 的 `package.json`（dependencies + bundles），**不要手改** `package.json` 或往 `node_modules` 里手写目录——link 目标不存在时 DSH 会把 profile 配置重置成默认模板。

## 用法

1. 鼠标移到任意一条回答的操作行，点双引号图标
2. 输入框里出现 `> 回答全文`，上方出现引用条
3. 在引用块下面写你的问题，按 Enter 发送
4. 发送后引用条消失

## 实现要点（踩坑记录）

### 1. client 插件不是 ESM

DSH 的 client 插件用经典脚本加载，入口必须是：

```js
window.__ModuleLoader__.load({
  id: 'dsh-quote',
  factory: () => {
    // ...
    return { inject: [], apply };
  },
});
```

写成 `export function apply` 会被浏览器当普通脚本执行，直接 `Uncaught SyntaxError: Unexpected token 'export'`，而且界面上没有任何提示——只有 DevTools Console 里能看到。这是最初折腾最久的一个坑。

### 2. 回答正文是分块渲染的

长回答在 DOM 里只渲染当前可见的块，`innerText` 只能拿到一部分。完整文本从操作行的 React fiber 上取：

```js
const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
let fiber = el[key];
while (fiber) {
  const props = fiber.memoizedProps;
  if (props && typeof props.text === 'string' && props.text.length > 20) {
    return props.text;
  }
  fiber = fiber.return;
}
```

`MessageIconActions` 组件的 `props.text` 就是复制按钮复制的原文，不受分块渲染影响。

### 3. 模型只能看到消息文本

引用条是纯前端 DOM，不会进入发送的消息，模型看不到。任何「引用」最终必须落到消息文本里（`> 内容`），否则模型不知道你引用了什么。这也是为什么本插件把全文预填进输入框，而不是只放在引用条里。

### 4. 改动后必须重启 DSH

`client.js` 的 bundle 地址带 `rev` hash，在 DSH 启动时计算。改完文件不重启，页面拉到的还是旧版。

## 已知限制

- 输入框预填全文后，长回答会让输入框很长——这是「让模型读到引用」的代价
- 引用条的位置是按输入框卡片的 DOM 结构定位的，DSH 大版本更新后可能需要跟着调
- 依赖 `__ModuleLoader__` 和 React fiber 的内部结构，属于非公开 API，升级可能失效

## License

MIT
