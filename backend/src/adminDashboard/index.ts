// Entry for the new Admin Control Center served at GET /admin-v2.
// Composes the modular pieces (layout, styles, script). Keep this file
// tiny — actual content lives in sibling modules.

import { adminDashboardLayout } from './layout';
import { adminDashboardScript } from './script';
import { adminDashboardStyles } from './styles';

export function renderAdminDashboardHtml(frontendUrl: string): string {
  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cheffity · Admin Control Center</title>
    <style>${adminDashboardStyles}</style>
  </head>
  <body>
    ${adminDashboardLayout()}
    <script>${adminDashboardScript(frontendUrl)}</script>
  </body>
</html>`;
}
