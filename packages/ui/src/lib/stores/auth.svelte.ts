/**
 * Auth store — manages API key and user state.
 * Uses Svelte 5 runes via module-level $state.
 */

import { hasApiKey, clearApiKey, getMe } from '$lib/api';

export interface User {
  id: string;
  name: string;
  role: string;
  email?: string;
}

// Module-level reactive state
let _user: User | null = $state(null);
let _isAuthenticated: boolean = $state(false);
let _isLoading: boolean = $state(true);

export function getUser(): User | null { return _user; }
export function getIsAuthenticated(): boolean { return _isAuthenticated; }
export function getIsLoading(): boolean { return _isLoading; }

export async function checkAuth(): Promise<boolean> {
  _isLoading = true;
  if (!hasApiKey()) {
    _user = null;
    _isAuthenticated = false;
    _isLoading = false;
    return false;
  }

  try {
    const { user } = await getMe();
    _user = user as User;
    _isAuthenticated = true;
    _isLoading = false;
    return true;
  } catch {
    _user = null;
    _isAuthenticated = false;
    _isLoading = false;
    return false;
  }
}

export function setUser(user: User): void {
  _user = user;
  _isAuthenticated = true;
  _isLoading = false;
}

export function logout(): void {
  clearApiKey();
  _user = null;
  _isAuthenticated = false;
}
