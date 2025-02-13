import { NOOP, extend } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import {
  DirtyLevels,
  type TrackOpTypes,
  type TriggerOpTypes,
} from './constants'
import type { Dep } from './dep'
import { type EffectScope, recordEffectScope } from './effectScope'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export let activeEffect: ReactiveEffect | undefined

export class ReactiveEffect<T = any> {
  active = true
  deps: Dep[] = []

  /**
   * Can be attached after creation
   * @internal
   */
  computed?: ComputedRefImpl<T>
  /**
   * 
   * @internal
   */
  allowRecurse?: boolean

  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  /**
   * @internal
   */
  _dirtyLevel = DirtyLevels.Dirty
  /**
   * @internal
   */
  _trackId = 0
  /**
   * @internal
   */
  _runnings = 0
  /**
   * @internal
   */
  _shouldSchedule = false
  /**
   * @internal
   */
  _depsLength = 0

  constructor(
    public fn: () => T, //传入一个依赖函数
    public trigger: () => void,
    public scheduler?: EffectScheduler, //执行过程： scheduler调度 => effect.run() => fn()
    scope?: EffectScope,
  ) {
    recordEffectScope(this, scope)
  }

  public get dirty() {
    if (
      this._dirtyLevel === DirtyLevels.MaybeDirty_ComputedSideEffect ||
      this._dirtyLevel === DirtyLevels.MaybeDirty
    ) {
      this._dirtyLevel = DirtyLevels.QueryingDirty
      pauseTracking()
      for (let i = 0; i < this._depsLength; i++) {
        const dep = this.deps[i]
        if (dep.computed) {
          triggerComputed(dep.computed)
          if (this._dirtyLevel >= DirtyLevels.Dirty) {
            break
          }
        }
      }
      if (this._dirtyLevel === DirtyLevels.QueryingDirty) {
        this._dirtyLevel = DirtyLevels.NotDirty
      }
      resetTracking()
    }
    return this._dirtyLevel >= DirtyLevels.Dirty
  }

  public set dirty(v) {
    this._dirtyLevel = v ? DirtyLevels.Dirty : DirtyLevels.NotDirty
  }

  //ReactiveEffect的run方法
  run() {
    //computed：运行锅一次就变成不是脏值了（不再是脏状态了）
    //这对于computed属性来说尤为重要，因为他们的值只在依赖发送变化时才需要重新计算（忽略）
    this._dirtyLevel = DirtyLevels.NotDirty
    //不是active的（active=false，直接执行即可，不需要做依赖收集
    if (!this.active) {
      return this.fn()
    }
    //保存上一次是否应该收集依赖的（解决嵌套effect使用的）
    let lastShouldTrack = shouldTrack
    //保存上一次的activeEffect（解决嵌套effect使用的）
    let lastEffect = activeEffect
    try {
      shouldTrack = true
      //这里是将当前的reactiveEffect赋值给了activeEffect
      //所以全局的activeEffect就有值了，那么我们收集依赖的时候就可以使用activeEffect了
      activeEffect = this   //ReactiveEffect对象就就意味着fn 
      this._runnings++  //记录是否在运行，运行完会--
      //在执行真正的effect函数之前，先把上一次的清除掉
      //为什么？因为我们使用v-if/else依赖的是不同的数据，获取某些数据在执行后就被移除了
      preCleanupEffect(this)
      //执行过程中会重新收集依赖
      return this.fn()
    } finally {
      //如果后续还有多余的不再使用的依赖，那么直接清除掉
      //第一次的依赖：{name,age,height，address}
      //第二次的依赖：{name,age}，那么height/address就需要清除掉
      postCleanupEffect(this)
      this._runnings--
      //执行完操作后再赋值给activeEffect
      activeEffect = lastEffect
      shouldTrack = lastShouldTrack
    }
  }

  stop() {
    if (this.active) {
      preCleanupEffect(this)
      postCleanupEffect(this)
      this.onStop && this.onStop()
      this.active = false
    }
  }
}

function triggerComputed(computed: ComputedRefImpl<any>) {
  return computed.value
}

function preCleanupEffect(effect: ReactiveEffect) {
  effect._trackId++
  effect._depsLength = 0
}

function postCleanupEffect(effect: ReactiveEffect) {
  if (effect.deps.length > effect._depsLength) {
    for (let i = effect._depsLength; i < effect.deps.length; i++) {
      cleanupDepEffect(effect.deps[i], effect)
    }
    effect.deps.length = effect._depsLength
  }
}

function cleanupDepEffect(dep: Dep, effect: ReactiveEffect) {
  const trackId = dep.get(effect)
  if (trackId !== undefined && effect._trackId !== trackId) {
    dep.delete(effect)
    if (dep.size === 0) {
      dep.cleanup()
    }
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

/**
 * Registers the given function to track reactive updates.
 *
 * The given function will be run once immediately. Every time any reactive
 * property that's accessed within it gets updated, the function will run again.
 *
 * @param fn - The function that will track reactive updates.
 * @param options - Allows to control the effect's behaviour.
 * @returns A runner that can be used to control the effect after creation.
 */
export function effect<T = any>(
  fn: () => T,
  //可以自己来控制effect的行为（比如说传入{scheduler:() => {} }）
  //这样可以覆盖ReactiveEffect的schedulder而执行自己的schedulder
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner {
  //判断是不是已经是一个ReactiveEffect的schedulder而执行自己的schedulder
  //effect(fn)
  //一个fn会创建一个ReactiveEffect对象
  //fn.effect = ReactiveEffect对象
  //ReactiveEffect对象.fn = fn

  //判断是不是已经是一个ReactiveEffect的副作用函数了，如果是的话就从里面提取出来(忽略)
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  //调用一次effect函数，会根据传入的fn,创建一个新的ReactiveEffect对象：_effect
  //根据fn -> _effect对象
  //fn会变成effect对象的的fn属性

  //当内部执行执行scheduler的时候，它会回头调用_effect的run,而run方法内部，会调用fn
  //scheduler() => run() => fn()
  //之后我们如果想要重新执行fn函数，只需要执行scheduler就可以了

  const _effect = new ReactiveEffect(fn, NOOP, () => {
    if (_effect.dirty) {
      _effect.run()
    }
  })
  
  //忽略
  if (options) {
    //直接将options添加到_effect对象上
    extend(_effect, options)
    // 判断是否有scope(方便一起来控制它们的)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }

  //没有options或者没有设置lazy选项，那么就执行一次
  if (!options || !options.lazy) {
    //非lazy状态下会执行一次_effect.run()
    _effect.run()
  }
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

export let shouldTrack = true
export let pauseScheduleStack = 0

const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

export function pauseScheduling() {
  pauseScheduleStack++
}

export function resetScheduling() {
  pauseScheduleStack--
  while (!pauseScheduleStack && queueEffectSchedulers.length) {
    queueEffectSchedulers.shift()!()
  }
}

export function trackEffect(
  effect: ReactiveEffect, //当前活跃的effect
  dep: Dep, //当前的依赖项
  debuggerEventExtraInfo?: DebuggerEventExtraInfo,
) {
  //当前依赖没有追踪该effect的_trackId
  //如果相等，说明已经收集了，{{message}}{{message}}这种多次使用的情况
  if (dep.get(effect) !== effect._trackId) {
    //将effect添加到dep中，并且给依赖项effect设置_trackId
    dep.set(effect, effect._trackId)
    //先不用管
    //获取当前依赖项数组的最后一个dep(这是上一次fn函数再执行的时候收集的dep)
    const oldDep = effect.deps[effect._depsLength]
    //如果数组最后一个dep不是当前dep，说明dep的依赖发生了变化
    //删除旧的dep，添加新的dep，比如{name:"why",nickname:"coderwhy"}
    //根据情况下判断到底是展示name或者nickname其中之一，那么切换时，旧需要切换dep
    if (oldDep !== dep) {
      if (oldDep) {
        //清除旧的依赖关系
        cleanupDepEffect(oldDep, effect)
      }
      //将新的dep添加到数组中，并且effect._depsLength长度+1
      //（这里没有使用push，而是直接往数组的最后一个位置添加dep，因为可以一次性做两个操作）
      effect.deps[effect._depsLength++] = dep
    } else {
      //如果最后一个dep是当前的依赖项，增加数组的长度
      effect._depsLength++
    }
    if (__DEV__) {
      // eslint-disable-next-line no-restricted-syntax
      effect.onTrack?.(extend({ effect }, debuggerEventExtraInfo!))
    }
  }
}

const queueEffectSchedulers: EffectScheduler[] = []

export function triggerEffects(
  dep: Dep,
  dirtyLevel: DirtyLevels,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo,
) {
  //暂停调度
  pauseScheduling()
  //遍历所有的keys，因为keys就是effect,执行它们
  for (const effect of dep.keys()) {
    // dep.get(effect) is very expensive, we need to calculate it lazily and reuse the result
    let tracking: boolean | undefined
    //控制computed是否应该执行
    if (
      effect._dirtyLevel < dirtyLevel &&
      (tracking ??= dep.get(effect) === effect._trackId)
    ) {
      effect._shouldSchedule ||= effect._dirtyLevel === DirtyLevels.NotDirty
      effect._dirtyLevel = dirtyLevel
    }
    if (
      effect._shouldSchedule &&
      (tracking ??= dep.get(effect) === effect._trackId)
    ) {
      if (__DEV__) {
        // eslint-disable-next-line no-restricted-syntax
        effect.onTrigger?.(extend({ effect }, debuggerEventExtraInfo))
      }
      //执行trigger(默认是空函数)
      effect.trigger()
      if (
        (!effect._runnings || effect.allowRecurse) &&
        effect._dirtyLevel !== DirtyLevels.MaybeDirty_ComputedSideEffect
      ) {
        effect._shouldSchedule = false
        if (effect.scheduler) {
          //将effect.schedulder加入到调度队列中
          queueEffectSchedulers.push(effect.scheduler)
        }
      }
    }
  }
  //恢复执行时，就会执行queueEffectSchedulers中的函数
  resetScheduling()
}
