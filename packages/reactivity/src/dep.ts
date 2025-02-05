import type { ReactiveEffect } from './effect'
import type { ComputedRefImpl } from './computed'

export type Dep = Map<ReactiveEffect, number> & {
  cleanup: () => void
  computed?: ComputedRefImpl<any>
}

export const createDep = (
  cleanup: () => void, //清理函数，不需要依赖项时调用
  computed?: ComputedRefImpl<any>, //？可选属性，判断依赖项是否是由计算属性触发的
): Dep => {
  //创建一个Map对象，作为依赖项
  const dep = new Map() as Dep
  dep.cleanup = cleanup
  dep.computed = computed
  return dep
}
