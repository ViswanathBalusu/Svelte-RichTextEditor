# Importer regressions (EXP-110)

Inputs that once made the importer crash or hang. The fuzz test saves a failing input here; the
replay test (`test/exp-110-regressions.test.ts`) imports every file on every run and requires a
result or an `ImportError` within a bound of time. Commit the file with its fix. The folder is empty
until a failure is found.
