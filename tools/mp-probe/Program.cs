using MemoryPack;

static void Dump(string label, byte[] bytes)
{
    Console.Write(label + " [" + bytes.Length + "]: ");
    foreach (var b in bytes) Console.Write(b.ToString("X2") + " ");
    Console.WriteLine();
}

var utf16 = MemoryPackSerializerOptions.Utf16;

// 1) string[] with a few Chinese / empty / null entries
string[] arr = ["标", "", null, "分城说明"];
Dump("string[]", MemoryPackSerializer.Serialize(arr, utf16));

// 2) single string
Dump("string 标", MemoryPackSerializer.Serialize("标", utf16));
Dump("string empty", MemoryPackSerializer.Serialize("", utf16));
Dump("string null", MemoryPackSerializer.Serialize<string>(null, utf16));

// 3) int[]
Dump("int[]", MemoryPackSerializer.Serialize(new int[] { 0, 1, 2, 481 }, utf16));
Dump("int[] null", MemoryPackSerializer.Serialize<int[]>(null, utf16));

// 4) an object with 2 members mimicking ReadonlyDenseDictionary_V2: int[] Keys, Row[] Values
Dump("dict-like", MemoryPackSerializer.Serialize(new DictLike
{
    Keys = [0, 1, 2],
    Values = [new Row { Id = 9000011u, Type = 4, Title = null, BgList = [481, 481, 481, 481], InfoList = [] }]
}, utf16));

[MemoryPackable]
public partial class DictLike
{
    public int[] Keys;
    public Row[] Values;
}

[MemoryPackable]
public partial class Row
{
    public uint Id;
    public int Type;
    public string[] Title;
    public int[] BgList;
    public int[] InfoList;
}
