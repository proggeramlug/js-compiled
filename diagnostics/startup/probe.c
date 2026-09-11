#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>

// Diagnostic ablations intentionally omit semantics. They are cost attribution,
// not production compiler optimizations or benchmark submissions.
static int tracing, mode;
static unsigned used;
static struct { const char *name; uint64_t ns; long before, after; } records[256];
static uint64_t now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000000000 + t.tv_nsec; }
static long rss(void) { struct rusage r; getrusage(RUSAGE_SELF, &r); return r.ru_maxrss; }
static void record(const char *name, uint64_t start, long before) {
  if (used < 256) { unsigned i = used++; records[i].name = name; records[i].ns = now() - start; records[i].before = before; records[i].after = rss(); }
}
static void snapshot(const char *stage) {
  char line[256]; FILE *f = fopen("/proc/self/smaps_rollup", "r");
  fprintf(stderr, "SNAPSHOT %s maxrss_kib=%ld\n", stage, rss());
  if (f) { while (fgets(line, sizeof(line), f)) if (!strncmp(line, "Rss:", 4) || !strncmp(line, "Pss:", 4) || !strncmp(line, "Private_Dirty:", 14) || !strncmp(line, "Anonymous:", 10)) fputs(line, stderr); fclose(f); }
}
__attribute__((constructor(101))) static void setup(void) {
  tracing = getenv("PERRY_STARTUP_TRACE") != NULL;
  const char *m = getenv("PERRY_STARTUP_ABLATE"); mode = m ? atoi(m) : 0;
  if (tracing) snapshot("constructor");
}

#define BEGIN long before = tracing ? rss() : 0; uint64_t start = tracing ? now() : 0
#define END(name) if (tracing) record(#name, start, before)
#define VOID0(name, mask) extern void __real_##name(void); void __wrap_##name(void) { BEGIN; if (!(mode & (mask))) __real_##name(); END(name); }
#define INT0(name, mask) extern int __real_##name(void); int __wrap_##name(void) { BEGIN; int out = (mode & (mask)) ? 0 : __real_##name(); END(name); return out; }

VOID0(js_gc_init, 2)
VOID0(js_run_stdlib_pump, 4)
VOID0(js_process_emit_before_exit_pending, 4)
VOID0(js_process_run_exit_sequence, 4)
VOID0(js_process_run_finalization_exit, 4)
VOID0(js_trace_events_flush_output, 4)
VOID0(js_promise_report_unhandled_rejections, 4)
VOID0(js_gc_release_current_thread_collection_side_allocations, 4)
VOID0(js_typed_feedback_maybe_dump_trace, 4)
INT0(js_promise_run_microtasks_event_loop, 4)
INT0(js_event_loop_host_driven, 4)
INT0(js_timer_has_pending, 4)
INT0(js_callback_timer_has_pending, 4)
INT0(js_interval_timer_has_pending, 4)
INT0(js_stdlib_has_active_handles, 4)
INT0(js_bun_ffi_has_active_threadsafe_callbacks, 4)
INT0(js_microtasks_pending, 4)
INT0(js_promise_run_promise_jobs, 4)
INT0(js_process_pending_exit_code, 4)

extern void __real_js_set_process_entry_path(const char *, int32_t);
void __wrap_js_set_process_entry_path(const char *p, int32_t n) { BEGIN; if (!(mode & 8)) __real_js_set_process_entry_path(p, n); END(js_set_process_entry_path); }
extern int64_t __real_js_string_from_bytes(const char *, int32_t);
int64_t __wrap_js_string_from_bytes(const char *p, int32_t n) { BEGIN; int64_t r = __real_js_string_from_bytes(p, n); END(js_string_from_bytes); return r; }
extern int64_t __real_js_array_alloc(int32_t);
int64_t __wrap_js_array_alloc(int32_t n) { BEGIN; int64_t r = __real_js_array_alloc(n); END(js_array_alloc); return r; }
extern int64_t __real_js_array_push_f64(int64_t, double);
int64_t __wrap_js_array_push_f64(int64_t p, double v) { BEGIN; int64_t r = __real_js_array_push_f64(p, v); END(js_array_push_f64); return r; }
extern void __real_js_console_log_spread(int64_t);
void __wrap_js_console_log_spread(int64_t p) { BEGIN; __real_js_console_log_spread(p); END(js_console_log_spread); }

extern int __real_main(void);
int __wrap_main(void) {
  if (tracing) snapshot("main_before");
  uint64_t start = now(); long before = rss();
  int result = (mode & 1) ? (puts("RESULT 0"), 0) : __real_main();
  if (tracing) {
    record("main_total", start, before);
    snapshot("main_after");
    for (unsigned i = 0; i < used; ++i) fprintf(stderr, "STAGE %s %.3f us rss_before=%ld rss_after=%ld\n", records[i].name, records[i].ns / 1000.0, records[i].before, records[i].after);
  }
  return result;
}
