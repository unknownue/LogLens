// cfg-types.ts — 配置表（GM10 client_cfg / MemoryPack）的共享类型与取值格式化。
// 独立成文件，避免 CfgTableTab（组件）与 cfg-columns（列宽计算）互相 import 成环，
// 同时让这些纯函数可以脱离浏览器直接测试。

/** 单元格值（tagged JSON：t=类型，v=值）。与后端 client_cfg.rs 的序列化对齐。 */
export interface CfgValue {
  t:
    | "null"
    | "bool"
    | "byte"
    | "int"
    | "uint"
    | "long"
    | "ulong"
    | "short"
    | "ushort"
    | "float"
    | "double"
    | "str"
    | "array"
    | "dict"
    | "set";
  v: unknown;
}

export interface CfgColumn {
  name: string;
  field_type: string;
}

export interface ClientCfgTable {
  name: string;
  columns: CfgColumn[];
  keys: number[];
  rows: CfgValue[][];
}

/** 把单元格值渲染成表格文本。 */
export function fmtValue(v: CfgValue | undefined | null): string {
  if (v == null || v.t === "null") {
    return "";
  }
  switch (v.t) {
    case "str":
      return String(v.v);
    case "bool":
      return v.v ? "true" : "false";
    case "array":
      return (v.v as CfgValue[]).map(fmtValue).join(", ");
    case "set":
      return (v.v as CfgValue[]).map(fmtValue).join(", ");
    case "dict":
      return (v.v as [CfgValue, CfgValue][])
        .map(([k, x]) => `${fmtValue(k)}: ${fmtValue(x)}`)
        .join(", ");
    default:
      return String(v.v);
  }
}

/** 从路径提取语言目录（.../client_cfg/<lang>/xxx.bin → <lang>）。 */
export function langOfPath(path: string): string | null {
  const m = path.toLowerCase().match(/[\\/]client_cfg[\\/]([^\\/]+)[\\/][^\\/]+\.bin$/);
  return m ? m[1] : null;
}
