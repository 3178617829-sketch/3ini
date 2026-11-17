import { invoke } from "@tauri-apps/api/core";

/** Rust 侧 `desktop_trash::TrashEntry` 的镜像（字段被 `#[serde(flatten)]` 摊平进 TrashEntryView）。 */
export interface TrashEntry {
  id: string;
  title: string;
  fileName: string;
  category: string;
  createdAt: string;
  deletedAt: string;
  wordCount: number;
  preview: string;
  /** 正文（读不到时是空串）。 */
  body: string;
  /** 距自动清理还剩几天；负数表示已过期。 */
  daysLeft: number;
}

/** 回收站保留天数，与 Rust 侧 `desktop_trash::TRASH_RETAIN_DAYS` 一致。 */
export const TRASH_RETAIN_DAYS = 30;

/** 全部回收站条目（倒序由后端保证：新删的在前）。 */
export function listTrash(): Promise<TrashEntry[]> {
  return invoke("trash_list");
}

/** 恢复一条：重建为笔记，同名自动加序号，不覆盖现有笔记。 */
export function restoreTrash(id: string): Promise<string> {
  return invoke("trash_restore", { id });
}

/** 彻底删掉一条（不可恢复）。 */
export function purgeTrash(id: string): Promise<void> {
  return invoke("trash_delete", { id });
}

/** 清空回收站，返回清掉的条数。 */
export function clearTrash(): Promise<number> {
  return invoke("trash_clear");
}
