// A model's name as people read it: the vendor prefix and the date suffix go, the version stays,
// so `claude-sonnet-5-5` reads `sonnet 5.5` and `claude-3-5-haiku-20241022` reads `haiku 3.5`. A
// name in any other form (`gpt-5-codex`, `qwen3-coder:30b`, `sonnet`) is left as it is. Screens show the
// full id as the hover title.

const NEW_FORM = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const OLD_FORM = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/;

const version = (major: string, minor: string | undefined): string => (minor === undefined ? major : `${major}.${minor}`);

export function shortModel(id: string): string {
  const current = NEW_FORM.exec(id);
  if (current !== null) return `${current[1]} ${version(current[2]!, current[3])}`;
  const older = OLD_FORM.exec(id);
  if (older !== null) return `${older[3]} ${version(older[1]!, older[2])}`;
  return id;
}
