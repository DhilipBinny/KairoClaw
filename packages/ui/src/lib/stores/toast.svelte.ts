interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

let _toasts: Toast[] = $state([]);
let _counter = 0;

export function getToasts(): Toast[] {
  return _toasts;
}

export function addToast(message: string, type: Toast['type'] = 'info'): void {
  const id = ++_counter;
  _toasts = [..._toasts, { id, message, type }];
  if (type !== 'error') {
    setTimeout(() => removeToast(id), 5000);
  }
}

export function removeToast(id: number): void {
  _toasts = _toasts.filter((t) => t.id !== id);
}
