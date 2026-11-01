export function getLocalApiProxyTarget(portText) {
  if (!/^\d+$/.test(portText)) throw new Error('PORT harus berupa angka antara 1 dan 65535.');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT harus berupa angka antara 1 dan 65535.');
  }
  return `http://127.0.0.1:${port}`;
}

export function createLocalViteEnvironment(source, portText) {
  const environment = {
    ...source,
    API_PROXY_TARGET: getLocalApiProxyTarget(portText),
  };
  const sensitiveName = /SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE|API[_-]?KEY|DATABASE|DB[_-]?(?:URL|DSN|PASSWORD|USER|HOST)|DSN|JWT|ACCESS[_-]?KEY|AUTH[_-]?(?:KEY|TOKEN)/i;
  for (const name of Object.keys(environment)) {
    if (name.startsWith('VITE_') || sensitiveName.test(name)) {
      delete environment[name];
    }
  }
  return environment;
}
