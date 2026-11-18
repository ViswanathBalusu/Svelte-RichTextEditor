// EXP-097: the Open XML SDK (MIT) on one file. Prints one JSON line: ok, time, peak memory, the
// counts of the typed elements it gives access to, and the text of the body.
//
// The SDK is a typed DOM over the package, not a converter: it recovers everything it can address
// and leaves the mapping to the caller. The counts here are what a mapper could read from it.
// Elements under mc:Fallback are skipped, as in the truth the harness compares against.
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using A = DocumentFormat.OpenXml.Drawing;

var path = args[0];
var sw = Stopwatch.StartNew();
object line;
try
{
    using var doc = WordprocessingDocument.Open(path, false);
    var main = doc.MainDocumentPart ?? throw new InvalidOperationException("no main document part");
    var body = main.Document?.Body ?? throw new InvalidOperationException("no body");

    // Visits the elements in document order, without entering a fallback branch.
    IEnumerable<OpenXmlElement> Walk(OpenXmlElement e)
    {
        foreach (var c in e.ChildElements)
        {
            if (c.LocalName == "Fallback") continue;
            yield return c;
            foreach (var d in Walk(c)) yield return d;
        }
    }

    var all = Walk(body).ToList();
    var text = new StringBuilder();
    foreach (var e in all)
    {
        switch (e)
        {
            case Text t: text.Append(t.Text); break;
            case TabChar: text.Append(' '); break;
            case Break: text.Append(' '); break;
            case Paragraph: text.Append('\n'); break;
        }
    }
    var footnotes = main.FootnotesPart?.Footnotes?.Elements<Footnote>()
        .Count(f => f.Type is null || f.Type.Value == FootnoteEndnoteValues.Normal) ?? 0;
    var comments = main.WordprocessingCommentsPart?.Comments?.Elements<Comment>().Count() ?? 0;
    line = new
    {
        ok = true,
        ms = sw.Elapsed.TotalMilliseconds,
        peakMb = Process.GetCurrentProcess().PeakWorkingSet64 / (1024.0 * 1024.0),
        counts = new
        {
            tables = all.Count(e => e is Table),
            images = all.Count(e => e is A.Blip),
            tracked = all.Where(e => e.NamespaceUri == "http://schemas.openxmlformats.org/wordprocessingml/2006/main" && (e.LocalName == "ins" || e.LocalName == "del")).Select(e => e.GetAttributes().FirstOrDefault(a => a.LocalName == "id").Value).Where(v => v is not null).Distinct().Count(),
            comments,
            footnotes,
            hyperlinks = all.Count(e => e is Hyperlink),
        },
        text = text.ToString(),
    };
}
catch (Exception e)
{
    line = new
    {
        ok = false,
        ms = sw.Elapsed.TotalMilliseconds,
        peakMb = Process.GetCurrentProcess().PeakWorkingSet64 / (1024.0 * 1024.0),
        error = $"{e.GetType().Name}: {e.Message}"[..Math.Min(200, $"{e.GetType().Name}: {e.Message}".Length)],
    };
}
Console.WriteLine(JsonSerializer.Serialize(line));
