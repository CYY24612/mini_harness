# agent-harness-lab

从零**手写**一个最小的 coding agent。

👉 **学习路径在 [docs/ROADMAP.md](docs/ROADMAP.md)。一次只看一节。**

---

## 目录

```
agent-harness-lab/
├─ app/                      ← ★ 你在这里从零写。我不预放任何代码。
├─ docs/
│   ├─ ROADMAP.md            路线图（唯一必读的文档）
│   └─ ts-primer.ts          TypeScript 速通，可运行：node docs/ts-primer.ts
├─ reference/                ← 完整实现 + 架构文档。**阶段 5 之前别打开。**
└─ .gitignore
```

## 现在在哪一步

看 [docs/ROADMAP.md](docs/ROADMAP.md) 顶部的 📍 标记。

## 三条规则

1. **一次只看一节路线图**，做完再往下滚。
2. **每步都有「验证」**，没过就不往下走。
3. **卡住超过 20 分钟就问我**，别硬扛 —— 你的敌人是 agent 的状态机，不该是语法。

## 关于 `reference/`

那是我一开始按「最终形态」搭的完整实现（2400 行，含事件日志、Provider 抽象、工具派发流水线、9 个离线场景测试，类型检查 0 错误）。

**它现在对你有害**，因为它把「重构后的结果」直接摆在你面前，跳过了所有需要你自己感受到的痛。

等你走到阶段 5，再打开它，那时你会觉得「哦，原来是在说这个」。
