import { ref, onUnmounted } from 'vue'

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
let refs = 0

export function useNow() {
  if (refs === 0) {
    timer = setInterval(() => { now.value = Date.now() }, 60_000)
  }
  refs++
  onUnmounted(() => {
    refs--
    if (refs === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  })
  return now
}
