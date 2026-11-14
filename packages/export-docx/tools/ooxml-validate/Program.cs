// EXP-090 criterion 7: validate each DOCX against the Office 2019 Open XML schemas.
//
// Usage: OoxmlValidate --out <result.json> <file.docx> [<file.docx> ...]
//
// The result is a JSON array with one object per file: { "file", "opened", "errors": [...] }.
// Each error carries the part's URI, the XPath of the node, the validator's id and its
// description. A file that cannot be opened as a package is reported with "opened": false
// and the exception message, and the process still exits 0; the caller decides.
using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

string? outPath = null;
var files = new List<string>();
for (int i = 0; i < args.Length; i++)
{
    if (args[i] == "--out" && i + 1 < args.Length)
    {
        outPath = args[++i];
    }
    else
    {
        files.Add(args[i]);
    }
}

if (outPath is null || files.Count == 0)
{
    Console.Error.WriteLine("usage: OoxmlValidate --out <result.json> <file.docx> ...");
    return 2;
}

var results = new List<Dictionary<string, object?>>();
foreach (var file in files)
{
    var row = new Dictionary<string, object?> { ["file"] = file };
    var errors = new List<Dictionary<string, object?>>();
    try
    {
        using var doc = WordprocessingDocument.Open(file, false);
        var validator = new OpenXmlValidator(FileFormatVersions.Office2019);
        foreach (var e in validator.Validate(doc))
        {
            errors.Add(new Dictionary<string, object?>
            {
                ["part"] = e.Part?.Uri.ToString(),
                ["path"] = e.Path?.XPath,
                ["id"] = e.Id,
                ["errorType"] = e.ErrorType.ToString(),
                ["description"] = e.Description,
            });
        }
        row["opened"] = true;
    }
    catch (Exception ex)
    {
        row["opened"] = false;
        row["exception"] = ex.GetType().Name + ": " + ex.Message;
    }
    row["errors"] = errors;
    results.Add(row);
}

var json = JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true });
await File.WriteAllTextAsync(outPath, json);
return 0;
