// Shared stream event store — allows useWebSocket to publish events
// and CliPanel to subscribe without a duplicate WebSocket connection.

let events = [];
let listeners = new Set();

export function pushEvents(newEvents) {
  events = newEvents;
  for (const listener of listeners) {
    listener(events);
  }
}

export function getEvents() {
  return events;
}

export function clearEvents() {
  events = [];
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
