import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ChevronLeft, ChevronRight, Plus, X, Trash2, Repeat, CalendarDays,
  ListChecks, Clock, Check, Grid2x2, Sparkles, Camera, Pencil,
} from "lucide-react";

/* ---------------------------------------------------------------------
   Storage shim for standalone deployment (StackBlitz / real hosting).
   The original file used window.storage, which only exists inside
   Claude's in-chat artifact preview. This version saves to the
   browser's own localStorage instead, so it works as a normal
   website / installed home-screen app.
--------------------------------------------------------------------- */
const storage = {
  async get(key) {
    try {
      const v = window.localStorage.getItem(key);
      return v !== null ? { key, value: v } : null;
    } catch (e) {
      return null;
    }
  },
  async set(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return { key, value };
    } catch (e) {
      return null;
    }
  },
};

/* ---------------- category system (todo / routine only) ---------------- */
const CATEGORIES = {
  assignment: { label: "과제", dot: "#F5B8D2", bg: "#FDEEF5", text: "#B15D82" },
  study:      { label: "공부", dot: "#F6E19A", bg: "#FDF7E2", text: "#A6862A" },
  hobby:      { label: "취미", dot: "#A9DCE6", bg: "#EBF8FA", text: "#3E8B99" },
  exercise:   { label: "운동", dot: "#D2C3EC", bg: "#F5F0FA", text: "#7B5CA6" },
  work:       { label: "업무", dot: "#BFE3B0", bg: "#F0F9EA", text: "#5C8A48" },
  etc:        { label: "기타", dot: "#D8BBA0", bg: "#F6EEE4", text: "#8C6A4C" },
};
const CAT_KEYS = Object.keys(CATEGORIES);

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WEEKDAYS_MINI = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const REPEAT_OPTIONS = [
  { key: "none", label: "반복 안함" },
  { key: "daily", label: "매일" },
  { key: "weekly", label: "매주" },
  { key: "monthly", label: "매월" },
  { key: "yearly", label: "매년" },
];

/* ---------------- date helpers ---------------- */
const pad2 = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayISO = () => toISO(new Date());
const parseISO = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (iso, n) => {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
};
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const formatDayTitle = (iso) => {
  const d = parseISO(iso);
  return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()} · ${WEEKDAYS[d.getDay()]}`;
};

function getMonthGrid(cursor) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const gridStart = new Date(year, month, 1 - startOffset);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push({ date: d, iso: toISO(d), inMonth: d.getMonth() === month });
  }
  return cells;
}

/* ---------------- image compression for cover photos ---------------- */
function compressImageFile(file, maxDim = 1000, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------- routine -> todo generation ---------------- */
const HORIZON_DAYS = 120;

function ensureRoutineTodos(routines, todos, rangeStartISO, rangeEndISO) {
  let additions = [];
  const existingKey = new Set(todos.map((t) => (t.routineId ? `${t.routineId}__${t.date}` : "")));
  for (const r of routines) {
    const effectiveStart = r.startDate && r.startDate > rangeStartISO ? r.startDate : rangeStartISO;
    let cursor = effectiveStart;
    let guard = 0;
    while (cursor <= rangeEndISO && guard < 400) {
      guard++;
      const dow = parseISO(cursor).getDay();
      if (r.days.includes(dow) && !r.excludedDates.includes(cursor) && !existingKey.has(`${r.id}__${cursor}`)) {
        additions.push({
          id: `t_${r.id}_${cursor}`, date: cursor, text: r.name, category: r.category,
          note: r.note || "", done: false, routineId: r.id, overridden: false,
        });
        existingKey.add(`${r.id}__${cursor}`);
      }
      cursor = addDays(cursor, 1);
    }
  }
  return { todos: additions.length ? [...todos, ...additions] : todos, changed: additions.length > 0 };
}

/* ---------------- recurring event series -> event instance generation ---------------- */
function ensureRecurringEvents(seriesList, events, rangeStartISO, rangeEndISO) {
  let additions = [];
  const existingKey = new Set(events.map((e) => (e.seriesId ? `${e.seriesId}__${e.date}` : "")));
  for (const s of seriesList) {
    const start = parseISO(s.startDate);
    let cursor = rangeStartISO < s.startDate ? s.startDate : rangeStartISO;
    let guard = 0;
    while (cursor <= rangeEndISO && guard < 500) {
      guard++;
      const d = parseISO(cursor);
      let matches = false;
      if (s.repeat === "daily") matches = true;
      else if (s.repeat === "weekly") matches = d.getDay() === start.getDay();
      else if (s.repeat === "monthly") matches = d.getDate() === Math.min(start.getDate(), daysInMonth(d.getFullYear(), d.getMonth()));
      else if (s.repeat === "yearly") matches = d.getMonth() === start.getMonth() && d.getDate() === Math.min(start.getDate(), daysInMonth(d.getFullYear(), d.getMonth()));

      if (matches && !s.excludedDates.includes(cursor) && !existingKey.has(`${s.id}__${cursor}`)) {
        additions.push({
          id: `e_${s.id}_${cursor}`, date: cursor, name: s.name, allDay: s.allDay,
          start: s.start, end: s.end, memo: s.memo || "", seriesId: s.id, overridden: false,
        });
        existingKey.add(`${s.id}__${cursor}`);
      }
      cursor = addDays(cursor, 1);
    }
  }
  return { events: additions.length ? [...events, ...additions] : events, changed: additions.length > 0 };
}

/* ---------------- storage ---------------- */
const STORAGE_KEY = "planner-data-v2";
const DEFAULT_DATA = { events: [], todos: [], routines: [], diary: {}, monthPhotos: {}, eventSeries: [] };

/* ================================================================== */

export default function App() {
  const [data, setData] = useState(DEFAULT_DATA);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef(null);

  const [monthCursor, setMonthCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState(null);
  const [screen, setScreen] = useState("calendar");
  const [eventModal, setEventModal] = useState(null);
  const [todoModal, setTodoModal] = useState(null);
  const [routineModal, setRoutineModal] = useState(null);
  const [expandedTodoId, setExpandedTodoId] = useState(null);
  const [confirmDeleteRoutine, setConfirmDeleteRoutine] = useState(null);
  const [confirmDeleteSeries, setConfirmDeleteSeries] = useState(null);

  /* ---- load ---- */
  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(STORAGE_KEY, false);
        let parsed = DEFAULT_DATA;
        if (res && res.value) {
          const raw = JSON.parse(res.value);
          parsed = {
            events: raw.events || [],
            todos: raw.todos || [],
            routines: raw.routines || [],
            diary: raw.diary || {},
            monthPhotos: raw.monthPhotos || {},
            eventSeries: raw.eventSeries || [],
          };
        }
        const rangeStart = addDays(todayISO(), -14);
        const rangeEnd = addDays(todayISO(), HORIZON_DAYS);
        const { todos } = ensureRoutineTodos(parsed.routines, parsed.todos, rangeStart, rangeEnd);
        const { events } = ensureRecurringEvents(parsed.eventSeries, parsed.events, rangeStart, rangeEnd);
        setData({ ...parsed, todos, events });
      } catch (e) {
        setData(DEFAULT_DATA);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  /* ---- debounced save ---- */
  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await storage.set(STORAGE_KEY, JSON.stringify(data), false);
      } catch (e) { /* best effort */ }
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [data, loaded]);

  /* ---- keep routine todos & recurring events generated as user browses months ---- */
  useEffect(() => {
    if (!loaded) return;
    const rangeStart = toISO(new Date(monthCursor.getFullYear(), monthCursor.getMonth(), -10));
    const rangeEnd = toISO(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 2, 10));
    setData((prev) => {
      const { todos, changed: c1 } = ensureRoutineTodos(prev.routines, prev.todos, rangeStart, rangeEnd);
      const { events, changed: c2 } = ensureRecurringEvents(prev.eventSeries, prev.events, rangeStart, rangeEnd);
      return c1 || c2 ? { ...prev, todos, events } : prev;
    });
  }, [monthCursor, loaded, data.routines.length, data.eventSeries.length]);

  /* ---------------- events CRUD ---------------- */
  const saveEvent = (form, repeat = "none") => {
    setData((prev) => {
      const exists = prev.events.some((e) => e.id === form.id);
      if (!exists && repeat !== "none") {
        const seriesId = `s_${Date.now()}`;
        const series = { id: seriesId, name: form.name, allDay: form.allDay, start: form.start, end: form.end, memo: form.memo, repeat, startDate: form.date, excludedDates: [] };
        const eventSeries = [...prev.eventSeries, series];
        const { events } = ensureRecurringEvents(eventSeries, prev.events, form.date, addDays(form.date, HORIZON_DAYS));
        return { ...prev, eventSeries, events };
      }
      const finalEvent = exists && form.seriesId ? { ...form, overridden: true } : { ...form, seriesId: form.seriesId || null };
      const events = exists ? prev.events.map((e) => (e.id === finalEvent.id ? finalEvent : e)) : [...prev.events, finalEvent];
      return { ...prev, events };
    });
    setEventModal(null);
  };
  const deleteEventInstance = (event) => {
    setData((prev) => {
      let eventSeries = prev.eventSeries;
      if (event.seriesId && !event.overridden) {
        eventSeries = prev.eventSeries.map((s) => (s.id === event.seriesId ? { ...s, excludedDates: [...new Set([...s.excludedDates, event.date])] } : s));
      }
      return { ...prev, eventSeries, events: prev.events.filter((e) => e.id !== event.id) };
    });
    setEventModal(null);
  };
  const deleteEventSeries = (seriesId) => {
    setData((prev) => {
      const today = todayISO();
      const events = prev.events
        .filter((e) => !(e.seriesId === seriesId && !e.overridden && e.date >= today))
        .map((e) => (e.seriesId === seriesId ? { ...e, seriesId: null } : e));
      return { ...prev, eventSeries: prev.eventSeries.filter((s) => s.id !== seriesId), events };
    });
    setConfirmDeleteSeries(null);
    setEventModal(null);
  };

  /* ---------------- todos CRUD ---------------- */
  const saveTodo = (todo, isRoutineInstanceEdit) => {
    setData((prev) => {
      const exists = prev.todos.some((t) => t.id === todo.id);
      const finalTodo = isRoutineInstanceEdit ? { ...todo, overridden: true } : todo;
      const todos = exists ? prev.todos.map((t) => (t.id === finalTodo.id ? finalTodo : t)) : [...prev.todos, finalTodo];
      return { ...prev, todos };
    });
    setTodoModal(null);
  };
  const toggleTodoDone = (id) => {
    setData((prev) => ({ ...prev, todos: prev.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)) }));
  };
  const deleteTodo = (todo) => {
    setData((prev) => {
      let routines = prev.routines;
      if (todo.routineId && !todo.overridden) {
        routines = prev.routines.map((r) => (r.id === todo.routineId ? { ...r, excludedDates: [...new Set([...r.excludedDates, todo.date])] } : r));
      }
      return { ...prev, routines, todos: prev.todos.filter((t) => t.id !== todo.id) };
    });
    setTodoModal(null);
  };

  /* ---------------- routines CRUD ---------------- */
  const saveRoutine = (routine) => {
    setData((prev) => {
      const exists = prev.routines.some((r) => r.id === routine.id);
      const routines = exists ? prev.routines.map((r) => (r.id === routine.id ? routine : r)) : [...prev.routines, routine];
      const today = todayISO();
      let todos = prev.todos.filter((t) => !(t.routineId === routine.id && !t.overridden && t.date >= today));
      const { todos: withNew } = ensureRoutineTodos(routines, todos, today, addDays(today, HORIZON_DAYS));
      return { ...prev, routines, todos: withNew };
    });
    setRoutineModal(null);
  };
  const deleteRoutine = (id) => {
    setData((prev) => {
      const today = todayISO();
      const todos = prev.todos
        .filter((t) => !(t.routineId === id && !t.overridden && t.date >= today))
        .map((t) => (t.routineId === id ? { ...t, routineId: null } : t));
      return { ...prev, routines: prev.routines.filter((r) => r.id !== id), todos };
    });
    setConfirmDeleteRoutine(null);
    setRoutineModal(null);
  };

  /* ---------------- diary ---------------- */
  const setDiary = (iso, text) => setData((prev) => ({ ...prev, diary: { ...prev.diary, [iso]: text } }));

  /* ---------------- cover photo ---------------- */
  const setMonthPhoto = (monthIndex, dataUrl) =>
    setData((prev) => ({ ...prev, monthPhotos: { ...prev.monthPhotos, [monthIndex]: dataUrl } }));
  const removeMonthPhoto = (monthIndex) =>
    setData((prev) => {
      const monthPhotos = { ...prev.monthPhotos };
      delete monthPhotos[monthIndex];
      return { ...prev, monthPhotos };
    });

  /* ---------------- derived ---------------- */
  const eventsFor = useCallback((iso) => data.events.filter((e) => e.date === iso).sort((a, b) => (a.allDay ? -1 : (a.start || "").localeCompare(b.start || ""))), [data.events]);
  const todosFor = useCallback((iso) => data.todos.filter((t) => t.date === iso), [data.todos]);
  const todoDotsFor = useCallback((iso) => {
    const cats = new Set();
    data.todos.filter((t) => t.date === iso).forEach((t) => cats.add(t.category));
    return [...cats].slice(0, 3);
  }, [data.todos]);

  if (!loaded) {
    return (
      <div style={{ ...rootStyle, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <FontStyle />
        <div style={{ color: SUBINK, fontFamily: "'Noto Sans KR', sans-serif" }}>불러오는 중…</div>
      </div>
    );
  }

  return (
    <div style={rootStyle}>
      <FontStyle />
      {screen === "calendar" && (
        <CalendarScreen
          monthCursor={monthCursor}
          setMonthCursor={setMonthCursor}
          selectedDate={selectedDate}
          setSelectedDate={setSelectedDate}
          eventsFor={eventsFor}
          todoDotsFor={todoDotsFor}
          openRoutines={() => setScreen("routines")}
          openYear={() => setScreen("year")}
          photoDataUrl={data.monthPhotos[monthCursor.getMonth()]}
          onPickPhoto={(dataUrl) => setMonthPhoto(monthCursor.getMonth(), dataUrl)}
          onRemovePhoto={() => removeMonthPhoto(monthCursor.getMonth())}
        />
      )}

      {screen === "year" && (
        <YearScreen
          year={monthCursor.getFullYear()}
          setYear={(y) => setMonthCursor(new Date(y, monthCursor.getMonth(), 1))}
          onBack={() => setScreen("calendar")}
          onPickMonth={(m) => { setMonthCursor(new Date(monthCursor.getFullYear(), m, 1)); setScreen("calendar"); }}
          onPickDate={(iso) => {
            setMonthCursor(new Date(parseISO(iso).getFullYear(), parseISO(iso).getMonth(), 1));
            setSelectedDate(iso);
            setScreen("calendar");
          }}
          todoDotsFor={todoDotsFor}
        />
      )}

      {screen === "routines" && (
        <RoutineScreen
          routines={data.routines}
          onBack={() => setScreen("calendar")}
          onAdd={() => setRoutineModal({ mode: "add", routine: { id: `r_${Date.now()}`, name: "", category: "etc", days: [], note: "", excludedDates: [], startDate: todayISO() } })}
          onEdit={(r) => setRoutineModal({ mode: "edit", routine: r })}
        />
      )}

      {selectedDate && (
        <DaySheet
          iso={selectedDate}
          onClose={() => setSelectedDate(null)}
          events={eventsFor(selectedDate)}
          todos={todosFor(selectedDate)}
          diaryText={data.diary[selectedDate] || ""}
          onDiaryChange={(text) => setDiary(selectedDate, text)}
          onAddEvent={() => setEventModal({ mode: "add", event: { id: `e_${Date.now()}`, date: selectedDate, name: "", allDay: true, start: "09:00", end: "10:00", memo: "", seriesId: null, overridden: false } })}
          onEditEvent={(ev) => setEventModal({ mode: "edit", event: ev })}
          onAddTodo={() => setTodoModal({ mode: "add", todo: { id: `t_${Date.now()}`, date: selectedDate, text: "", category: "etc", note: "", done: false, routineId: null, overridden: false } })}
          onEditTodo={(t) => setTodoModal({ mode: "edit", todo: t })}
          onToggleTodo={toggleTodoDone}
          expandedTodoId={expandedTodoId}
          setExpandedTodoId={setExpandedTodoId}
        />
      )}

      {eventModal && (
        <EventModal
          mode={eventModal.mode}
          event={eventModal.event}
          onClose={() => setEventModal(null)}
          onSave={saveEvent}
          onDeleteInstance={deleteEventInstance}
          onRequestDeleteSeries={(ev) => setConfirmDeleteSeries(ev)}
        />
      )}

      {todoModal && (
        <TodoModal mode={todoModal.mode} todo={todoModal.todo} onClose={() => setTodoModal(null)} onSave={saveTodo} onDelete={deleteTodo} />
      )}

      {routineModal && (
        <RoutineModal mode={routineModal.mode} routine={routineModal.routine} onClose={() => setRoutineModal(null)} onSave={saveRoutine} onRequestDelete={(r) => setConfirmDeleteRoutine(r)} />
      )}

      {confirmDeleteRoutine && (
        <ConfirmDialog
          title="루틴을 삭제할까요?"
          message={`"${confirmDeleteRoutine.name}" 루틴을 삭제하면 오늘 이후의 반복 일정이 사라져요. 이미 지난 기록은 남아요.`}
          onCancel={() => setConfirmDeleteRoutine(null)}
          onConfirm={() => deleteRoutine(confirmDeleteRoutine.id)}
        />
      )}

      {confirmDeleteSeries && (
        <ConfirmDialog
          title="반복 일정을 전체 삭제할까요?"
          message={`"${confirmDeleteSeries.name}" 일정의 앞으로의 반복이 모두 사라져요. 이미 지난 일정은 남아요.`}
          onCancel={() => setConfirmDeleteSeries(null)}
          onConfirm={() => deleteEventSeries(confirmDeleteSeries.seriesId)}
        />
      )}
    </div>
  );
}

/* ================================================================== */
/* styling constants                                                   */
/* ================================================================== */
const PAPER = "#FDF8EF";
const INK = "#4A4038";
const SUBINK = "#A69A85";
const ACCENT = "#7BBCAE";
const ACCENT_SOFT = "#EAF5F2";
const LINE = "#F0E6D2";
const EVENT_BAR_BG = "#F6D8C8";
const EVENT_BAR_TEXT = "#8C5A3E";

const rootStyle = {
  maxWidth: 460, margin: "0 auto", minHeight: "100vh", background: PAPER, color: INK,
  fontFamily: "'Noto Sans KR', sans-serif", position: "relative", paddingBottom: 24,
};

function FontStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Gaegu:wght@400;700&family=Noto+Sans+KR:wght@400;500;700&display=swap');
      * { box-sizing: border-box; }
      input, textarea, select, button { font-family: 'Noto Sans KR', sans-serif; }
      ::-webkit-scrollbar { width: 0px; height: 0px; }
      input[type="time"], input[type="date"] { color-scheme: light; }
    `}</style>
  );
}

const iconBtnStyle = {
  width: 38, height: 38, borderRadius: 14, border: `1.5px solid ${LINE}`,
  background: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
  cursor: "pointer", color: INK, boxShadow: "0 2px 0 rgba(184,160,120,0.15)", flexShrink: 0,
};

/* ================================================================== */
/* Cover photo                                                          */
/* ================================================================== */
function CoverPhoto({ photoDataUrl, onPick, onRemove }) {
  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await compressImageFile(file);
      onPick(dataUrl);
    } catch (err) { /* ignore */ }
    e.target.value = "";
  };
  const hiddenInputStyle = {
    position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
    overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0,
  };

  return (
    <div style={{ padding: "16px 18px 0" }}>
      {photoDataUrl ? (
        <div style={{ position: "relative", width: "100%", aspectRatio: "16/10", borderRadius: 20, overflow: "hidden", boxShadow: "0 3px 0 rgba(184,160,120,0.12)" }}>
          <img src={photoDataUrl} alt="month cover" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          <label
            style={{ position: "absolute", right: 10, bottom: 10, width: 34, height: 34, borderRadius: 99, background: "rgba(255,255,255,0.92)", boxShadow: "0 2px 6px rgba(0,0,0,0.2)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
          >
            <input type="file" accept="image/*" onChange={handleFile} style={hiddenInputStyle} />
            <Pencil size={15} color={INK} />
          </label>
          <button
            onClick={onRemove}
            style={{ position: "absolute", right: 52, bottom: 10, width: 34, height: 34, borderRadius: 99, border: "none", background: "rgba(255,255,255,0.92)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 2px 6px rgba(0,0,0,0.2)" }}
          >
            <X size={15} color={INK} />
          </button>
        </div>
      ) : (
        <label
          style={{
            position: "relative", width: "100%", aspectRatio: "16/10", borderRadius: 20, border: `1.5px dashed ${LINE}`,
            background: "#FFFCF6", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 6, color: SUBINK, cursor: "pointer",
          }}
        >
          <input type="file" accept="image/*" onChange={handleFile} style={hiddenInputStyle} />
          <Camera size={22} />
          <span style={{ fontSize: 12.5 }}>이 달의 커버 사진 추가하기</span>
        </label>
      )}
    </div>
  );
}

/* ================================================================== */
/* Calendar screen                                                     */
/* ================================================================== */
function CalendarScreen({ monthCursor, setMonthCursor, selectedDate, setSelectedDate, eventsFor, todoDotsFor, openRoutines, openYear, photoDataUrl, onPickPhoto, onRemovePhoto }) {
  const cells = getMonthGrid(monthCursor);
  const today = todayISO();
  const goto = (delta) => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + delta, 1));

  return (
    <div>
      <CoverPhoto photoDataUrl={photoDataUrl} onPick={onPickPhoto} onRemove={onRemovePhoto} />

      <div style={{ padding: "18px 18px 8px", display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <button
          onClick={openYear}
          style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, textAlign: "left", display: "flex", flexDirection: "column" }}
        >
          <span style={{ fontSize: 13, color: SUBINK, letterSpacing: 1 }}>{monthCursor.getFullYear()}</span>
          <span style={{ fontFamily: "'Gaegu', cursive", fontSize: 34, fontWeight: 700, color: INK, lineHeight: 1.05 }}>
            {MONTH_NAMES[monthCursor.getMonth()]}
          </span>
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={iconBtnStyle} onClick={openYear} aria-label="연간 보기"><Grid2x2 size={17} /></button>
          <button style={iconBtnStyle} onClick={openRoutines} aria-label="루틴 관리"><Repeat size={17} /></button>
        </div>
      </div>

      <div style={{ padding: "0 18px", display: "flex", alignItems: "center", justifyContent: "space-between", margin: "10px 0 16px" }}>
        <button style={iconBtnStyle} onClick={() => goto(-1)} aria-label="이전 달"><ChevronLeft size={18} /></button>
        <button
          onClick={() => setMonthCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
          style={{ border: `1.5px dashed ${ACCENT}`, background: ACCENT_SOFT, color: "#4E8A7C", borderRadius: 999, padding: "6px 20px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "'Gaegu', cursive" }}
        >
          Today
        </button>
        <button style={iconBtnStyle} onClick={() => goto(1)} aria-label="다음 달"><ChevronRight size={18} /></button>
      </div>

      <div style={{ padding: "0 12px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", marginBottom: 4 }}>
          {WEEKDAYS.map((w, i) => (
            <div key={w} style={{ textAlign: "center", fontSize: 10, letterSpacing: 0.5, color: i === 0 ? "#E19693" : i === 6 ? "#8CADD6" : SUBINK, padding: "4px 0", fontWeight: 600 }}>
              {w}
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
          {cells.map(({ date, iso, inMonth }) => {
            const isToday = iso === today;
            const isSelected = iso === selectedDate;
            const dow = date.getDay();
            const dayEvents = eventsFor(iso);
            const dots = todoDotsFor(iso);
            return (
              <button
                key={iso}
                onClick={() => setSelectedDate(iso)}
                style={{
                  minHeight: 76,
                  border: isSelected ? `1.5px dashed ${ACCENT}` : "1.5px solid transparent",
                  background: isSelected ? ACCENT_SOFT : "transparent",
                  borderRadius: 14, cursor: "pointer", display: "flex", flexDirection: "column",
                  alignItems: "stretch", padding: "4px 2px", gap: 2, opacity: inMonth ? 1 : 0.3,
                }}
              >
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <span
                    style={{
                      width: 22, height: 22, borderRadius: 99, display: "flex", alignItems: "center", justifyContent: "center",
                      fontFamily: "'Gaegu', cursive", fontSize: 13, fontWeight: isToday ? 700 : 500,
                      background: isToday ? ACCENT : "transparent",
                      color: isToday ? "#fff" : dow === 0 ? "#E19693" : dow === 6 ? "#8CADD6" : INK,
                    }}
                  >
                    {date.getDate()}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {dayEvents.slice(0, 2).map((ev) => (
                    <span
                      key={ev.id}
                      style={{
                        fontSize: 7.5, lineHeight: "11px", padding: "1px 3px", borderRadius: 3,
                        background: EVENT_BAR_BG, color: EVENT_BAR_TEXT, whiteSpace: "nowrap",
                        overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600,
                      }}
                    >
                      {ev.name || "(No title)"}
                    </span>
                  ))}
                  {dayEvents.length > 2 && (
                    <span style={{ fontSize: 7, color: SUBINK, textAlign: "center" }}>+{dayEvents.length - 2}</span>
                  )}
                </div>
                {dots.length > 0 && (
                  <div style={{ display: "flex", gap: 2, justifyContent: "center", marginTop: "auto", paddingTop: 2 }}>
                    {dots.map((c) => <span key={c} style={{ width: 4, height: 4, borderRadius: 99, background: CATEGORIES[c].dot, display: "inline-block" }} />)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Year screen                                                          */
/* ================================================================== */
function MiniMonth({ year, month, onPickMonth, onPickDate, todoDotsFor }) {
  const cursor = new Date(year, month, 1);
  const cells = getMonthGrid(cursor);
  const today = todayISO();
  return (
    <div style={{ background: "#fff", border: `1.5px solid ${LINE}`, borderRadius: 16, padding: "10px 8px 12px", boxShadow: "0 2px 0 rgba(184,160,120,0.08)" }}>
      <button
        onClick={() => onPickMonth(month)}
        style={{ background: "transparent", border: "none", cursor: "pointer", fontFamily: "'Gaegu', cursive", fontSize: 15, fontWeight: 700, color: INK, marginBottom: 6, padding: "0 2px" }}
      >
        {MONTH_ABBR[month]}
      </button>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 1 }}>
        {WEEKDAYS_MINI.map((w, i) => (
          <div key={`${w}${i}`} style={{ textAlign: "center", fontSize: 8.5, color: SUBINK }}>{w}</div>
        ))}
        {cells.map(({ date, iso, inMonth }) => {
          if (!inMonth) return <div key={iso} />;
          const isToday = iso === today;
          const dots = todoDotsFor(iso);
          return (
            <button
              key={iso}
              onClick={() => onPickDate(iso)}
              style={{
                border: "none", background: isToday ? ACCENT : "transparent", color: isToday ? "#fff" : INK,
                borderRadius: 6, fontSize: 9, padding: "2px 0", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
              }}
            >
              {date.getDate()}
              <span style={{ width: 3, height: 3, borderRadius: 99, background: dots[0] ? CATEGORIES[dots[0]].dot : "transparent" }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function YearScreen({ year, setYear, onBack, onPickMonth, onPickDate, todoDotsFor }) {
  return (
    <div>
      <div style={{ padding: "22px 18px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button style={iconBtnStyle} onClick={onBack}><ChevronLeft size={18} /></button>
          <div style={{ fontFamily: "'Gaegu', cursive", fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
            <Sparkles size={16} color={ACCENT} /> {year} Overview
          </div>
        </div>
      </div>
      <div style={{ padding: "0 18px 12px", display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <button style={iconBtnStyle} onClick={() => setYear(year - 1)}><ChevronLeft size={16} /></button>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{year}</div>
        <button style={iconBtnStyle} onClick={() => setYear(year + 1)}><ChevronRight size={16} /></button>
      </div>
      <div style={{ padding: "0 14px 30px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {Array.from({ length: 12 }).map((_, m) => (
          <MiniMonth key={m} year={year} month={m} onPickMonth={onPickMonth} onPickDate={onPickDate} todoDotsFor={todoDotsFor} />
        ))}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Day bottom sheet                                                     */
/* ================================================================== */
function DaySheet({ iso, onClose, events, todos, diaryText, onDiaryChange, onAddEvent, onEditEvent, onAddTodo, onEditTodo, onToggleTodo, expandedTodoId, setExpandedTodoId }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 40, maxWidth: 460, margin: "0 auto" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(51,48,42,0.35)" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, top: "9%", background: PAPER, borderTopLeftRadius: 22, borderTopRightRadius: 22, display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 -8px 30px rgba(0,0,0,0.15)" }}>
        <div style={{ padding: "14px 18px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${LINE}` }}>
          <div style={{ fontFamily: "'Gaegu', cursive", fontSize: 21, fontWeight: 700 }}>{formatDayTitle(iso)}</div>
          <button style={iconBtnStyle} onClick={onClose}><X size={17} /></button>
        </div>

        <div style={{ overflowY: "auto", padding: "14px 18px 30px", flex: 1 }}>
          <SectionHeader icon={<CalendarDays size={15} />} title="Schedule" onAdd={onAddEvent} />
          {events.length === 0 && <EmptyRow text="등록된 일정이 없어요" />}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
            {events.map((ev) => (
              <button key={ev.id} onClick={() => onEditEvent(ev)} style={{ textAlign: "left", border: `1.5px solid ${LINE}`, borderRadius: 16, padding: "11px 13px", background: "#fff", cursor: "pointer", display: "flex", gap: 10, alignItems: "flex-start", boxShadow: "0 2px 0 rgba(184,160,120,0.08)" }}>
                <span style={{ width: 5, alignSelf: "stretch", borderRadius: 4, background: EVENT_BAR_BG, minHeight: 30 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
                    {ev.name || "(제목 없음)"}
                    {ev.seriesId && <Repeat size={11} color={SUBINK} />}
                  </div>
                  <div style={{ fontSize: 12, color: SUBINK, marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
                    <Clock size={11} />
                    {ev.allDay ? "하루 종일" : `${ev.start} ~ ${ev.end}`}
                  </div>
                  {ev.memo && <div style={{ fontSize: 12, color: SUBINK, marginTop: 4 }}>{ev.memo}</div>}
                </div>
              </button>
            ))}
          </div>

          <SectionHeader icon={<ListChecks size={15} />} title="To-do List" onAdd={onAddTodo} />
          {todos.length === 0 && <EmptyRow text="등록된 할 일이 없어요" />}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
            {todos.map((t) => {
              const expanded = expandedTodoId === t.id;
              return (
                <div key={t.id} style={{ border: `1.5px solid ${LINE}`, borderRadius: 16, background: "#fff", overflow: "hidden", boxShadow: "0 2px 0 rgba(184,160,120,0.06)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                    <button onClick={() => onToggleTodo(t.id)} style={{ width: 21, height: 21, borderRadius: 99, border: `1.5px solid ${t.done ? ACCENT : "#D8CDB4"}`, background: t.done ? ACCENT : "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
                      {t.done && <Check size={13} color="#fff" />}
                    </button>
                    <span style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 999, flexShrink: 0, background: CATEGORIES[t.category].bg, color: CATEGORIES[t.category].text, fontWeight: 600 }}>
                      {CATEGORIES[t.category].label}
                    </span>
                    <div onClick={() => setExpandedTodoId(expanded ? null : t.id)} style={{ flex: 1, fontSize: 14, textDecoration: t.done ? "line-through" : "none", color: t.done ? SUBINK : INK, cursor: "pointer" }}>
                      {t.text || "(내용 없음)"}
                      {t.routineId && <Repeat size={10} style={{ marginLeft: 5, verticalAlign: "middle", color: SUBINK }} />}
                    </div>
                    <button onClick={() => onEditTodo(t)} style={{ border: "none", background: "transparent", color: SUBINK, cursor: "pointer", fontSize: 12, flexShrink: 0 }}>수정</button>
                  </div>
                  {expanded && <div style={{ padding: "0 12px 12px 42px", fontSize: 12, color: SUBINK, lineHeight: 1.5 }}>{t.note ? t.note : "메모 없음"}</div>}
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 15, fontFamily: "'Gaegu', cursive", fontWeight: 700, marginBottom: 8, color: INK, display: "flex", alignItems: "center", gap: 5 }}>
            <Sparkles size={13} color={ACCENT} /> Memo
          </div>
          <textarea
            value={diaryText}
            onChange={(e) => onDiaryChange(e.target.value)}
            placeholder="오늘 하루는 어땠나요? ✏️"
            style={{ width: "100%", minHeight: 110, border: `1.5px dashed ${LINE}`, borderRadius: 16, padding: 14, fontSize: 13.5, color: INK, background: "#FFFCF6", resize: "vertical", outline: "none", lineHeight: 1.7 }}
          />
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ icon, title, onAdd }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 17, fontFamily: "'Gaegu', cursive", fontWeight: 700, color: ACCENT }}>{icon} {title}</div>
      <button onClick={onAdd} style={{ ...iconBtnStyle, width: 30, height: 30, borderRadius: 10 }}><Plus size={15} /></button>
    </div>
  );
}
function EmptyRow({ text }) {
  return <div style={{ fontSize: 12.5, color: SUBINK, padding: "8px 2px 16px" }}>{text}</div>;
}

/* ================================================================== */
/* Modal shell                                                          */
/* ================================================================== */
function ModalShell({ title, onClose, children, footer }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, maxWidth: 460, margin: "0 auto" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(51,48,42,0.4)" }} />
      <div style={{ position: "absolute", left: 12, right: 12, top: "50%", transform: "translateY(-50%)", background: "#fff", borderRadius: 22, maxHeight: "84vh", display: "flex", flexDirection: "column", boxShadow: "0 10px 40px rgba(0,0,0,0.25)", overflow: "hidden" }}>
        <div style={{ padding: "16px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1.5px dashed ${LINE}` }}>
          <div style={{ fontSize: 19, fontFamily: "'Gaegu', cursive", fontWeight: 700 }}>{title}</div>
          <button style={iconBtnStyle} onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ padding: 18, overflowY: "auto" }}>{children}</div>
        {footer && <div style={{ padding: "12px 18px 18px", borderTop: `1px solid ${LINE}` }}>{footer}</div>}
      </div>
    </div>
  );
}

const fieldLabelStyle = { fontSize: 12.5, fontWeight: 700, color: SUBINK, marginBottom: 6, display: "block" };
const inputStyle = { width: "100%", border: `1.5px solid ${LINE}`, borderRadius: 14, padding: "10px 12px", fontSize: 14, outline: "none", color: INK, background: "#FDFBF6" };
const primaryBtnStyle = { width: "100%", background: ACCENT, color: "#fff", border: "none", borderRadius: 999, padding: "13px 0", fontSize: 14.5, fontWeight: 700, cursor: "pointer", boxShadow: "0 3px 0 #5B9A8B" };
const dangerBtnStyle = { width: "100%", background: "transparent", color: "#C0574C", border: `1.5px dashed #E4C7C2`, borderRadius: 999, padding: "10px 0", fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 };

function CategoryPicker({ value, onChange }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {CAT_KEYS.map((k) => (
        <button key={k} onClick={() => onChange(k)} style={{ border: value === k ? `2px solid ${CATEGORIES[k].dot}` : `1px solid ${LINE}`, background: CATEGORIES[k].bg, color: CATEGORIES[k].text, borderRadius: 999, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
          {CATEGORIES[k].label}
        </button>
      ))}
    </div>
  );
}

function RepeatPicker({ value, onChange }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {REPEAT_OPTIONS.map((o) => (
        <button key={o.key} onClick={() => onChange(o.key)} style={{ border: value === o.key ? `2px solid ${ACCENT}` : `1px solid ${LINE}`, background: value === o.key ? ACCENT_SOFT : "#fff", color: value === o.key ? "#4E8A7C" : INK, borderRadius: 999, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ================================================================== */
/* Event modal                                                          */
/* ================================================================== */
function EventModal({ mode, event, onClose, onSave, onDeleteInstance, onRequestDeleteSeries }) {
  const [form, setForm] = useState(event);
  const [repeat, setRepeat] = useState("none");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const isSeriesInstance = mode === "edit" && !!form.seriesId;

  return (
    <ModalShell
      title={mode === "add" ? "일정 추가" : "일정 수정"}
      onClose={onClose}
      footer={
        <>
          <button style={primaryBtnStyle} onClick={() => onSave(form, repeat)} disabled={!form.name.trim()}>저장</button>
          {mode === "edit" && !isSeriesInstance && (
            <button style={dangerBtnStyle} onClick={() => onDeleteInstance(form)}><Trash2 size={14} /> 일정 삭제</button>
          )}
          {mode === "edit" && isSeriesInstance && (
            <>
              <button style={dangerBtnStyle} onClick={() => onDeleteInstance(form)}><Trash2 size={14} /> 이 날짜만 삭제</button>
              <button style={{ ...dangerBtnStyle, marginTop: 6 }} onClick={() => onRequestDeleteSeries(form)}><Repeat size={14} /> 반복 전체 삭제</button>
            </>
          )}
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {isSeriesInstance && (
          <div style={{ fontSize: 12, color: ACCENT, background: "#EAF2F0", borderRadius: 8, padding: "8px 10px", display: "flex", gap: 6, alignItems: "center" }}>
            <Repeat size={13} /> 반복 일정의 일부예요 · 여기서 수정하면 이 날짜에만 적용돼요
          </div>
        )}
        <div>
          <label style={fieldLabelStyle}>일정 이름</label>
          <input style={inputStyle} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="예: 팀 회의" />
        </div>
        <div>
          <label style={fieldLabelStyle}>날짜</label>
          <input type="date" style={inputStyle} value={form.date} onChange={(e) => set("date", e.target.value)} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={form.allDay} onChange={(e) => set("allDay", e.target.checked)} id="allday" style={{ width: 16, height: 16 }} />
          <label htmlFor="allday" style={{ fontSize: 13.5 }}>하루 종일</label>
        </div>
        {!form.allDay && (
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={fieldLabelStyle}>시작</label>
              <input type="time" style={inputStyle} value={form.start} onChange={(e) => set("start", e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={fieldLabelStyle}>종료</label>
              <input type="time" style={inputStyle} value={form.end} onChange={(e) => set("end", e.target.value)} />
            </div>
          </div>
        )}
        {mode === "add" && (
          <div>
            <label style={fieldLabelStyle}>반복</label>
            <RepeatPicker value={repeat} onChange={setRepeat} />
          </div>
        )}
        <div>
          <label style={fieldLabelStyle}>메모</label>
          <textarea style={{ ...inputStyle, minHeight: 70, resize: "vertical" }} value={form.memo} onChange={(e) => set("memo", e.target.value)} placeholder="메모를 남겨보세요" />
        </div>
      </div>
    </ModalShell>
  );
}

/* ================================================================== */
/* Todo modal (single-date instance)                                    */
/* ================================================================== */
function TodoModal({ mode, todo, onClose, onSave, onDelete }) {
  const [form, setForm] = useState(todo);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const isRoutineInstance = !!form.routineId;

  return (
    <ModalShell
      title={mode === "add" ? "할 일 추가" : "할 일 수정"}
      onClose={onClose}
      footer={
        <>
          <button style={primaryBtnStyle} onClick={() => onSave(form, isRoutineInstance)} disabled={!form.text.trim()}>저장</button>
          {mode === "edit" && (
            <button style={dangerBtnStyle} onClick={() => onDelete(form)}><Trash2 size={14} /> 이 날짜에서만 삭제</button>
          )}
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {isRoutineInstance && (
          <div style={{ fontSize: 12, color: ACCENT, background: "#EAF2F0", borderRadius: 8, padding: "8px 10px", display: "flex", gap: 6, alignItems: "center" }}>
            <Repeat size={13} /> 루틴에서 생성됨 · 여기서 수정하면 이 날짜에만 적용돼요
          </div>
        )}
        <div>
          <label style={fieldLabelStyle}>할 일</label>
          <input style={inputStyle} value={form.text} onChange={(e) => set("text", e.target.value)} placeholder="예: 영어 단어 암기" />
        </div>
        <div>
          <label style={fieldLabelStyle}>날짜</label>
          <input type="date" style={inputStyle} value={form.date} onChange={(e) => set("date", e.target.value)} />
        </div>
        <div>
          <label style={fieldLabelStyle}>종류</label>
          <CategoryPicker value={form.category} onChange={(v) => set("category", v)} />
        </div>
        <div>
          <label style={fieldLabelStyle}>정보 (작게 표시돼요)</label>
          <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} value={form.note} onChange={(e) => set("note", e.target.value)} placeholder="세부 내용을 적어보세요" />
        </div>
      </div>
    </ModalShell>
  );
}

/* ================================================================== */
/* Routine screen + modal                                               */
/* ================================================================== */
function RoutineScreen({ routines, onBack, onAdd, onEdit }) {
  return (
    <div>
      <div style={{ padding: "22px 18px 10px", display: "flex", alignItems: "center", gap: 10 }}>
        <button style={iconBtnStyle} onClick={onBack}><ChevronLeft size={18} /></button>
        <div style={{ fontFamily: "'Gaegu', cursive", fontSize: 23, fontWeight: 700 }}>Routine</div>
      </div>
      <div style={{ padding: "6px 18px 4px" }}>
        <button onClick={onAdd} style={{ width: "100%", border: `1.5px dashed ${ACCENT}`, borderRadius: 16, padding: "13px 0", background: ACCENT_SOFT, color: "#4E8A7C", fontWeight: 700, fontSize: 13.5, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontFamily: "'Gaegu', cursive" }}>
          <Plus size={16} /> 새 루틴 만들기
        </button>
      </div>
      <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
        {routines.length === 0 && <EmptyRow text="아직 만든 루틴이 없어요" />}
        {routines.map((r) => (
          <button key={r.id} onClick={() => onEdit(r)} style={{ textAlign: "left", border: `1.5px solid ${LINE}`, borderRadius: 16, background: "#fff", padding: "12px 14px", cursor: "pointer", display: "flex", gap: 10, alignItems: "center", boxShadow: "0 2px 0 rgba(184,160,120,0.08)" }}>
            <span style={{ width: 5, alignSelf: "stretch", minHeight: 40, borderRadius: 4, background: CATEGORIES[r.category].dot }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700 }}>{r.name || "(이름 없음)"}</div>
              <div style={{ fontSize: 12, color: SUBINK, marginTop: 3 }}>
                {r.days.length === 7 ? "매일" : r.days.length === 0 ? "요일 미설정" : r.days.slice().sort().map((d) => WEEKDAYS[d]).join(", ")}
                <span style={{ marginLeft: 6, color: CATEGORIES[r.category].text }}>· {CATEGORIES[r.category].label}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function RoutineModal({ mode, routine, onClose, onSave, onRequestDelete }) {
  const [form, setForm] = useState(routine);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleDay = (d) => setForm((f) => ({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] }));

  return (
    <ModalShell
      title={mode === "add" ? "루틴 만들기" : "루틴 수정"}
      onClose={onClose}
      footer={
        <>
          <button style={primaryBtnStyle} onClick={() => onSave(form)} disabled={!form.name.trim() || form.days.length === 0}>저장 (오늘부터 반영)</button>
          {mode === "edit" && <button style={dangerBtnStyle} onClick={() => onRequestDelete(form)}><Trash2 size={14} /> 루틴 삭제</button>}
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={fieldLabelStyle}>루틴 이름</label>
          <input style={inputStyle} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="예: 아침 스트레칭" />
        </div>
        <div>
          <label style={fieldLabelStyle}>반복 요일</label>
          <div style={{ display: "flex", gap: 6 }}>
            {WEEKDAYS_MINI.map((w, i) => (
              <button key={`${w}${i}`} onClick={() => toggleDay(i)} style={{ width: 34, height: 34, borderRadius: 99, cursor: "pointer", border: form.days.includes(i) ? "none" : `1px solid ${LINE}`, background: form.days.includes(i) ? ACCENT : "#fff", color: form.days.includes(i) ? "#fff" : INK, fontSize: 13, fontWeight: 600 }}>
                {w}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label style={fieldLabelStyle}>종류</label>
          <CategoryPicker value={form.category} onChange={(v) => set("category", v)} />
        </div>
        <div>
          <label style={fieldLabelStyle}>정보</label>
          <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} value={form.note} onChange={(e) => set("note", e.target.value)} placeholder="루틴에 대한 세부 내용" />
        </div>
        <div style={{ fontSize: 11.5, color: SUBINK, lineHeight: 1.5 }}>
          이 화면에서 수정하면 오늘 이후의 모든 반복 일정에 반영돼요. 특정 날짜만 바꾸고 싶다면 해당 날짜의 할 일 화면에서 수정해 주세요.
        </div>
      </div>
    </ModalShell>
  );
}

/* ================================================================== */
/* Confirm dialog                                                       */
/* ================================================================== */
function ConfirmDialog({ title, message, onCancel, onConfirm }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, maxWidth: 460, margin: "0 auto" }}>
      <div onClick={onCancel} style={{ position: "absolute", inset: 0, background: "rgba(51,48,42,0.45)" }} />
      <div style={{ position: "absolute", left: 24, right: 24, top: "50%", transform: "translateY(-50%)", background: "#fff", borderRadius: 16, padding: 20, boxShadow: "0 10px 40px rgba(0,0,0,0.3)" }}>
        <div style={{ fontSize: 15.5, fontWeight: 700, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13, color: SUBINK, lineHeight: 1.55, marginBottom: 18 }}>{message}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: `1px solid ${LINE}`, background: "#fff", cursor: "pointer", fontSize: 13.5, fontWeight: 600 }}>취소</button>
          <button onClick={onConfirm} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#C0574C", color: "#fff", cursor: "pointer", fontSize: 13.5, fontWeight: 700 }}>삭제</button>
        </div>
      </div>
    </div>
  );
}
