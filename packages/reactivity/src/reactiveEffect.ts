import { isArray, isIntegerKey, isMap, isSymbol } from '@vue/shared'
import { DirtyLevels, type TrackOpTypes, TriggerOpTypes } from './constants'
import { type Dep, createDep } from './dep'
import {
  activeEffect,
  pauseScheduling,
  resetScheduling,
  shouldTrack,
  trackEffect,
  triggerEffects,
} from './effect'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Maps to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<object, KeyToDepMap>()

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

/**
 * Tracks access to a reactive property.
 *
 * This will check which effect is running at the moment and record it as dep
 * which records all effects that depend on the reactive property.
 *
 * @param target - Object holding the reactive property.
 * @param type - Defines the type of access to the reactive property.
 * @param key - Identifier of the reactive property to track.
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  //需要跟踪数据，并且activeEffect是有值的（activeEffect当前的ReactEffect对象实例）
  if (shouldTrack && activeEffect) {
    //根据target对象取出对应的depsMap
    //targetMap weakMap
    //targetMap = {
    //  key：{name: '王小波', age: 18}
    //  value: new Map(
    //              'name': new Map(
    //                            ReactiveEffect(fn函数):_trackId(1)
    //                        )
    //           )
    //}
    let depsMap = targetMap.get(target)
    //没有取出来，那么会创建一个新的Map，并设置到targetMap中
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    //根据key去获取对应的依赖，dep的本质是另一个Map对象
    let dep = depsMap.get(key)
    //没有对应的依赖，那么就会添加依赖
    if (!dep) {
      //这里有一个细节 dep = createDep(() => depsMap!.delete(key))
      //并且它传入一个清理函数，某一个key不再需要依赖响应时，调用它的clean方法就可以了
      depsMap.set(key, (dep = createDep(() => depsMap!.delete(key))))
    }
    trackEffect(
      activeEffect,
      dep,
      __DEV__
        ? {
            target,
            type,
            key,
          }
        : void 0,
    )
  }
}

/**
 * Finds all deps associated with the target (or a specific property) and
 * triggers the effects stored within.
 *
 * @param target - The reactive object.
 * @param type - Defines the type of the operation that needs to trigger effects.
 * @param key - Can be used to target a specific reactive property in the target object.
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>,
) {
  //获取target对应的依赖depsMap
  const depsMap = targetMap.get(target)
  //没有获取到，直接返回
  if (!depsMap) {
    // never been tracked
    return
  }

  //初始化一个列表，用来存放需要执行的dep（有可能不是一个）
  let deps: (Dep | undefined)[] = []
  //如果类型是清空的，那么直接全部加入到deps
  //这是针对Map/Set它们的操作，如果被清空，那么他们对象的依赖应该都要被收集才对
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) { //r如果修改的是数组的length
    //遍历depsMap,将key为length，并且大于newLength的添加到deps中
    //因为直接设置长度变小的话，那么后续的元素会被移除，那么它就需要更新依赖了
    const newLength = Number(newValue)
    depsMap.forEach((dep, key) => {
      if (key === 'length' || (!isSymbol(key) && key >= newLength)) {
        deps.push(dep)
      }
    })
  } else {

    //其他忽略，这个最重要
    //对于set/add/delete类型的操作，将指定的key相关的依赖添加deps
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    //根据不同的情况，添加到deps依赖中（迭代器的集合）（不重要）
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  //暂停调度
  pauseScheduling()
  //遍历deps,触发每个依赖的更新效果
  for (const dep of deps) {
    if (dep) {
      triggerEffects(
        dep,
        DirtyLevels.Dirty,
        __DEV__
          ? {
              target,
              type,
              key,
              newValue,
              oldValue,
              oldTarget,
            }
          : void 0,
      )
    }
  }
  resetScheduling()
}

export function getDepFromReactive(object: any, key: PropertyKey) {
  const depsMap = targetMap.get(object)
  return depsMap && depsMap.get(key)
}
