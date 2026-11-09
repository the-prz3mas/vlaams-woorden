# Vlaamse woorden

Aplikacja do powtórek holenderskich czasowników nieregularnych (powtórki rozłożone w czasie).

- Adres: https://the-prz3mas.github.io/vlaams-woorden/
- Na iPhonie: otwórz adres w Safari → Udostępnij → **Dodaj do ekranu początkowego**.
- Postępy: `Dropbox/Aplikacje/nl-leren/vlaams-woorden/postepy.json` (aplikacja Dropbox `nl-leren`, tryb App folder). Wspólne dla telefonu i komputera, nie trafiają do repozytorium.

## Słówka

Lista jest w `data/slowka.json`. Każdy czasownik:

```json
{ "id": "bijten", "nl": "bijten", "pl": "gryźć", "imp_ev": "beet", "imp_mv": "beten", "hulp": "hebben", "vd": "gebeten", "groep": "ij" }
```

- `id` musi być unikalne i się nie zmieniać (po nim zapisane są postępy).
- `hulp`: `hebben`, `zijn` albo `hebben/zijn` (obie odpowiedzi są poprawne).
- `groep`: jedna z kluczy w `groepen` na górze pliku.

Po zmianie pliku: commit + push, GitHub Pages opublikuje nową wersję w ~1 min.

## Tryby

- **Formy**: bezokolicznik → imperfectum (lp/lm), hebben/zijn, voltooid deelwoord.
- **Znaczenie**: polskie znaczenie → bezokolicznik.
- **Trening dodatkowy**: 15 losowych słówek z grupy, bez wpływu na plan powtórek.

Poziomy: 0 → 1 → 2 → 4 → 8 → 16 → 32 → 64 dni. Błąd = powrót na poziom 0 i powtórka na końcu sesji.
