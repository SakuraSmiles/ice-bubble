<script setup lang="ts">
/**
 * VirtualScroller — 通用 Vue 3 虚拟滚动组件
 *
 * 功能：
 * - 只渲染可见区域 + 上下各 overscan 条，大幅减少 DOM 节点
 * - 支持固定高度（itemHeight）和动态高度（ResizeObserver）
 * - 向上滚动时保持滚动位置不跳动（使用锚定项 + 偏移）
 * - 提供 scrollToBottom / scrollToTop 的 ref 方法
 *
 * 在 ChatTimeline 中集成示例：
 * ```vue
 * <VirtualScroller :items="messages" :item-height="120" container-height="calc(100vh - 180px)">
 *   <template #default="{ item }">
 *     <MessageBubble :message="item" />
 *   </template>
 * </VirtualScroller>
 * ```
 */
import { ref, computed, onMounted, onUnmounted, watch, nextTick, type PropType } from 'vue';

// ============ 类型 ============
interface VirtualScrollerItem {
  id: string;
  [key: string]: unknown;
}

// ============ Props ============
const props = defineProps({
  /** 全部数据项 */
  items: {
    type: Array as PropType<VirtualScrollerItem[]>,
    required: true,
  },
  /** 固定项高度（px），启用动态高度时忽略 */
  itemHeight: {
    type: Number,
    default: 80,
  },
  /** 容器高度（CSS 值），如 "600px" 或 "calc(100vh - 180px)" */
  containerHeight: {
    type: String,
    default: '400px',
  },
  /** 可视区外额外渲染的项数（上下各 overscan 条） */
  overscan: {
    type: Number,
    default: 5,
  },
  /** 是否启用动态高度测量 */
  dynamicHeight: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits<{
  (e: 'scrollEnd'): void;
}>();

// ============ Refs ============
const containerRef = ref<HTMLElement | null>(null);
const innerRef = ref<HTMLElement | null>(null);

// 动态高度缓存：index → height (px)
const heightCache = ref<Record<number, number>>({});

// ============ 滚动状态 ============
const scrollTop = ref(0);
const viewportHeight = ref(0);

// ============ ResizeObserver — 容器高度 ============
let containerResizeObserver: ResizeObserver | null = null;

onMounted(() => {
  if (containerRef.value) {
    containerResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        viewportHeight.value = entry.contentRect.height;
      }
    });
    containerResizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  containerResizeObserver?.disconnect();
});

// ============ 高度缓存 ============
/**
 * 获取项索引 i 的预估高度。
 * 如果 itemHeight 显式指定且未启用动态高度，返回 itemHeight。
 * 否则从缓存查找，找不到返回 itemHeight。
 */
function getItemHeight(i: number): number {
  if (!props.dynamicHeight) return props.itemHeight;
  return heightCache.value[i] ?? props.itemHeight;
}

/** 计算累计偏移（"总高度"） */
function getOffsetForIndex(i: number): number {
  let offset = 0;
  for (let j = 0; j < i && j < props.items.length; j++) {
    offset += getItemHeight(j);
  }
  return offset;
}

/** 总内容高度 */
function getTotalHeight(): number {
  let h = 0;
  for (let j = 0; j < props.items.length; j++) {
    h += getItemHeight(j);
  }
  return h;
}

// ============ 动态高度测量 ============
let itemsObserver: ResizeObserver | null = null;
const observedElements = new WeakMap<Element, number>();

function observeRenderedItems() {
  if (!props.dynamicHeight || !innerRef.value) return;

  // 断开旧 observer
  itemsObserver?.disconnect();
  itemsObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const index = observedElements.get(entry.target);
      if (index === undefined) continue;
      const newH = entry.contentRect.height;
      const oldH = heightCache.value[index];
      if (oldH !== newH) {
        heightCache.value[index] = newH;
        changed = true;
      }
    }
    // 高度缓存变化时强制重新计算（但不改变 scrollTop）
    if (changed) {
      // trigger reactivity
      heightCache.value = { ...heightCache.value };
    }
  });

  // 观察 .vs-item 元素
  const items = innerRef.value.querySelectorAll('.vs-item');
  items.forEach((el) => {
    // 实际索引由 data-index 获取
    const idx = Number((el as HTMLElement).dataset.index);
    if (!isNaN(idx)) {
      observedElements.set(el, idx);
      itemsObserver!.observe(el);
    }
  });
}

// 数据变化或重渲染后重新测量
watch(
  () => [innerRef.value, props.items.length],
  () => {
    nextTick(() => observeRenderedItems());
  }
);

// ============ 虚拟渲染计算 ============
const totalHeight = computed(() => getTotalHeight());

/**
 * 二分查找：给定 scrollTop，找到第一个累积偏移超过 scrollTop 的索引。
 */
function findStartIndex(offset: number): number {
  const len = props.items.length;
  if (len === 0) return 0;

  let lo = 0;
  let hi = len - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midEnd = getOffsetForIndex(mid) + getItemHeight(mid);
    if (midEnd <= offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

const startIndex = computed(() => {
  const idx = findStartIndex(scrollTop.value);
  return Math.max(0, idx - props.overscan);
});

const endIndex = computed(() => {
  if (props.items.length === 0) return 0;
  const end = findStartIndex(scrollTop.value + viewportHeight.value) + 1;
  return Math.min(props.items.length, end + props.overscan);
});

const visibleItems = computed(() => {
  return props.items.slice(startIndex.value, endIndex.value);
});

const offsetY = computed(() => {
  return getOffsetForIndex(startIndex.value);
});

// ============ 滚动锚定（防止向上滚动时跳动） ============
function onScroll() {
  if (!containerRef.value) return;
  const st = containerRef.value.scrollTop;
  scrollTop.value = st;

  // 检测是否滚动到底部
  if (containerRef.value.scrollHeight - st - containerRef.value.clientHeight < 10) {
    emit('scrollEnd');
  }
}

// ============ 对外暴露方法 ============
function scrollToBottom() {
  if (!containerRef.value) return;
  nextTick(() => {
    if (containerRef.value) {
      containerRef.value.scrollTop = containerRef.value.scrollHeight;
    }
  });
}

function scrollToTop() {
  if (!containerRef.value) return;
  containerRef.value.scrollTop = 0;
}

/** 滚动到指定索引处 */
function scrollToIndex(index: number, behavior: ScrollBehavior = 'auto') {
  if (!containerRef.value) return;
  const offset = getOffsetForIndex(index);
  containerRef.value.scrollTo({ top: offset, behavior });
}

defineExpose({ scrollToBottom, scrollToTop, scrollToIndex });
</script>

<template>
  <div
    ref="containerRef"
    class="virtual-scroller"
    :style="{ height: containerHeight }"
    @scroll="onScroll"
  >
    <!-- 占位撑高 -->
    <div class="virtual-scroller-spacer" :style="{ height: totalHeight + 'px' }">
      <!-- 可视区容器，通过 translateY 定位 -->
      <div
        ref="innerRef"
        class="virtual-scroller-inner"
        :style="{ transform: `translateY(${offsetY}px)` }"
      >
        <div
          v-for="(item, idx) in visibleItems"
          :key="item.id"
          class="vs-item"
          :data-index="startIndex + idx"
        >
          <slot name="default" :item="item" :index="startIndex + idx" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-scroller {
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  scrollbar-width: thin;
  scrollbar-color: rgba(144, 147, 153, 0.6) transparent;
}

.virtual-scroller::-webkit-scrollbar {
  width: 6px;
}

.virtual-scroller::-webkit-scrollbar-track {
  background: transparent;
}

.virtual-scroller::-webkit-scrollbar-thumb {
  background: rgba(144, 147, 153, 0.6);
  border-radius: 3px;
}

.virtual-scroller-spacer {
  position: relative;
  width: 100%;
}

.virtual-scroller-inner {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  will-change: transform;
}

.vs-item {
  /* 默认不设高度，由内容撑开 */
}
</style>
