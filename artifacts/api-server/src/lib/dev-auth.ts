export function getDevelopmentLoginEmail(): string | null {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.DEV_SKIP_LOGIN !== "true"
  ) {
    return null;
  }

  const email = process.env.DEV_LOGIN_EMAIL?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}