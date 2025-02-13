import { ErrorCodes, callWithErrorHandling, handleError } from './errorHandling'
import { type Awaited, NOOP, isArray } from '@vue/shared'
import { type ComponentInternalInstance, getComponentName } from './component'

export interface SchedulerJob extends Function {
  id?: number
  pre?: boolean
  active?: boolean
  computed?: boolean
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  allowRecurse?: boolean
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   */
  i?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

let isFlushing = false
let isFlushPending = false

const queue: SchedulerJob[] = []
let flushIndex = 0

const pendingPostFlushCbs: SchedulerJob[] = []
let activePostFlushCbs: SchedulerJob[] | null = null
let postFlushIndex = 0

const resolvedPromise = /*#__PURE__*/ Promise.resolve() as Promise<any>
let currentFlushPromise: Promise<void> | null = null

const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob, number>

export function nextTick<T = void, R = void>(
  this: T,
  fn?: (this: T) => R,
): Promise<Awaited<R>> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
function findInsertionIndex(id: number) {
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJob = queue[middle]
    const middleJobId = getId(middleJob)
    if (middleJobId < id || (middleJobId === id && middleJob.pre)) {
      start = middle + 1
    } else {
      end = middle
    }
  }

  return start
}

export function queueJob(job: SchedulerJob) {
  // the dedupe search uses the startIndex argument of Array.includes()
  // by default the search index includes the current job that is being run
  // so it cannot recursively trigger itself again.
  // if the job is a watch() callback, the search will start with a +1 index to
  // allow it recursively trigger itself - it is the user's responsibility to
  // ensure it doesn't end up in an infinite loop.
  //做去重判断，如果已经存在任务，那么不需要重复添加
  //比如count++多次调用，那么对于更新DOM操作只需要执行一次即可
  //如果队列为空 ！queue.length
  //或者如果队列中没有包含该任务，都需要进入到if中，添加任务
  if (
    !queue.length ||
    !queue.includes(
      job,
      isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex,
    )
  ) {
    //如果id为null，没有id的任务直接添加到队列的尾部
    if (job.id == null) {
      queue.push(job)
    } else {
      //有id,使用二分查找法找到位置，插入进去
      queue.splice(findInsertionIndex(job.id), 0, job)
    }
    //触发任务执行的流程（flush）
    queueFlush()
  }
}

function queueFlush() {
  //队列不是正在执行或者等待执行，开始执行队列
  //isFlushing或者isFlushPending说明队列正在处理或者等待执行，不需要多次触发了
  if (!isFlushing && !isFlushPending) {
    //这里便是正在等待执行，寂静开始处理微任务（因为是加入到then才真正开始处理的）
    isFlushPending = true
    //在下一个微任务中开始执行队列（当前代码可能在执行上一次微任务或者同步任务）
    //使用微任务可以等到当前代码（比如同步代码）执行完毕（将该放入的任务全部给我放入完，我等会会儿才会执行你）
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

export function queuePostFlushCb(cb: SchedulerJobs) {
  if (!isArray(cb)) {
    if (
      !activePostFlushCbs ||
      !activePostFlushCbs.includes(
        cb,
        cb.allowRecurse ? postFlushIndex + 1 : postFlushIndex,
      )
    ) {
      pendingPostFlushCbs.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    pendingPostFlushCbs.push(...cb)
  }
  queueFlush()
}

//执行Pre队列
export function flushPreFlushCbs(
  instance?: ComponentInternalInstance,   //可以传入一个组件，那么就属于某一个组件的任务
  seen?: CountMap, //记录已经执行过的任务，防止重复执行
  // if currently flushing, skip the current job itself
  i = isFlushing ? flushIndex + 1 : 0,
) {
  if (__DEV__) {
    seen = seen || new Map()
  }

  //遍历queue,并且通过cb执行任务
  for (; i < queue.length; i++) {
    const cb = queue[i]
    //检测任务是否存在，并且pre为true(提前执行pre)
    if (cb && cb.pre) {
      if (instance && cb.id !== instance.uid) {
        continue
      }
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      queue.splice(i, 1)
      i--
      cb()
    }
  }
}

export function flushPostFlushCbs(seen?: CountMap) {
  //pendingPostFlushCbs是一个临时队列，可以存放主任务执行完后需要执行的回调
  if (pendingPostFlushCbs.length) {
    //去重和根据id做一个排序
    const deduped = [...new Set(pendingPostFlushCbs)].sort(
      (a, b) => getId(a) - getId(b),
    )
    //清空pendingPostFlushCbs队列
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    //如果activePostFlushCbs有值，说明存在嵌套的activePostFlushCbs，加入到activePostFlushCbs,先不执行
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    //将之前的deduped赋值给activePostFlushCbs
    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    //遍历其中的每一个任务，执行队列
    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      //拿到任务
      const cb = activePostFlushCbs[postFlushIndex]
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      //active不是false,那么就执行cb回调
      if (cb.active !== false) cb()
    }
    //重置一些变量
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id

const comparator = (a: SchedulerJob, b: SchedulerJob): number => {
  //获取a任务和b任务的id，比较他们的差值
  //任务id越小，优先级越高
  const diff = getId(a) - getId(b)
  //想通的情况下，进一步检查他们的pre属性
  if (diff === 0) {
    //a有pre b没有pre,返回-1 a-b=-1 a的优先级更高
    if (a.pre && !b.pre) return -1
    //b有pre a没有pre,返回1 a-b=1 b的优先级更高
    if (b.pre && !a.pre) return 1
  }
  return diff
}

function flushJobs(seen?: CountMap) {
  //等待的状态已经设置为false(要开始执行了)
  isFlushPending = false
  //执行的状态变为true
  isFlushing = true
  if (__DEV__) {
    seen = seen || new Map()
  }

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  //排序 比如组件的更新是先父组件到子组件，比如一个组件在父组件更新过程中被卸载了，那么它的更新会被忽略
  //pre排序，pre的任务优先被执行
  queue.sort(comparator)

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    //for循环遍历所有的任务，执行队列中的任务
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      //判断job有没有失效（比如组件已经卸载，那么这个组件的更新操作就不需要做了）
      if (job && job.active !== false) {
        if (__DEV__ && check(job)) {
          continue
        }
        //执行任务，并且有错误给用户提示
        callWithErrorHandling(
          job,
          job.i,
          job.i ? ErrorCodes.COMPONENT_UPDATE : ErrorCodes.SCHEDULER,
        )
      }
    }
  } finally {
    //重置一些变量
    flushIndex = 0
    queue.length = 0
    //队列执行完后，执行Post队列
    flushPostFlushCbs(seen)

    //isFlushing设置为false
    isFlushing = false
    //currentFlushPromise设置为null
    currentFlushPromise = null
    // some postFlushCb queued jobs!
    // keep flushing until it drains.
    //如果还有一些job，继续执行
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.i
      const componentName = instance && getComponentName(instance.type)
      handleError(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`,
        null,
        ErrorCodes.APP_ERROR_HANDLER,
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
