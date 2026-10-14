/** A page name is one portable directory component, including legacy Unicode names. */
export function isSafePageName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.trim().length > 0
    && value !== '.' && value !== '..'
    && !/[\\/\x00-\x1f<>:"|?*]/.test(value)
    && !/[. ]$/.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value);
}

export function assertPageName(value) {
  if (isSafePageName(value)) return value;
  const error = new Error('页名无效：必须是单个安全目录名');
  error.code = 'invalid-page-name';
  throw error;
}
