# 通知偏好 Spec
用户修改音量并看到即时预览，保存返回实际持久化结果。当前只保存 volume，范围 0..100。
## 已接受设计
采用 design/accepted.md 和 design/reference.html 的 r2 关系，覆盖桌面 1200×800 与窄屏 420×820。
## 技术决定
已有 savePreferences({volume}) 接口，失败应保留输入并显示可重试错误。
## 实现自由
DOM、CSS 和内部事件组织允许等价变化。
