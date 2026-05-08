/**
 * Workbench route — pure server component. The actual interactive
 * shell (`EqtyModule`) is a client component that this page mounts as
 * an island; keeping the page itself server-rendered lets Next 14
 * stream the shell into the route group's layout without bloating the
 * client bundle with another `'use client'` boundary.
 */

import { EqtyModule } from '../../components/modules/eqty-module.js';

export default function WorkbenchPage(): React.ReactElement {
  return <EqtyModule />;
}
