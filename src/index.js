// src/index.js
export const name = 'project-session-store'

// 不注入任何服务，我们是去替换 sessionPersistence 的
export const inject = []

export function apply(ctx) {
  // 只做一个动作：提供一个空的持久化服务占位
  // 所有方法都返回“未实现”，但服务本身存在，不会让依赖它的插件 pending
  ctx.set('sessionPersistence', {})
}