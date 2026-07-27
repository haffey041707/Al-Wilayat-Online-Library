#!/usr/bin/env python3
"""Build web/js/duas31.js — 31 short duas (Arabic + transliteration + English),
auto-translated into Urdu/Farsi/Azerbaijani/Malay. Kashmiri→Urdu, Dari→Farsi,
Singapore→English are handled by the app's language mapping.
"""
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(__file__))
from translate_hadith import translate

LANGS = ["ur", "fa", "az", "ms"]
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "js", "duas31.js")

# ar = Arabic, tr = transliteration, en = English meaning, src = reference
DUAS = [
    ("رَبِّ زِدْنِي عِلْمًا", "Rabbi zidni ‘ilma", "My Lord, increase me in knowledge.", "Qur'an 20:114"),
    ("رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً وَفِي الْآخِرَةِ حَسَنَةً وَقِنَا عَذَابَ النَّارِ", "Rabbana atina fid-dunya hasanah wa fil-akhirati hasanah wa qina ‘adhab an-nar", "Our Lord, give us good in this world and good in the Hereafter, and protect us from the punishment of the Fire.", "Qur'an 2:201"),
    ("رَبَّنَا لَا تُؤَاخِذْنَا إِن نَّسِينَا أَوْ أَخْطَأْنَا", "Rabbana la tu’akhidhna in nasina aw akhta’na", "Our Lord, do not impose blame upon us if we forget or make a mistake.", "Qur'an 2:286"),
    ("حَسْبُنَا اللَّهُ وَنِعْمَ الْوَكِيلُ", "Hasbunallahu wa ni‘mal-wakil", "Allah is sufficient for us, and He is the best Disposer of affairs.", "Qur'an 3:173"),
    ("رَبِّ اشْرَحْ لِي صَدْرِي وَيَسِّرْ لِي أَمْرِي", "Rabbi ishrah li sadri wa yassir li amri", "My Lord, expand for me my breast and ease for me my task.", "Qur'an 20:25-26"),
    ("رَبَّنَا عَلَيْكَ تَوَكَّلْنَا وَإِلَيْكَ أَنَبْنَا", "Rabbana ‘alayka tawakkalna wa ilayka anabna", "Our Lord, upon You we rely, and to You we turn in repentance.", "Qur'an 60:4"),
    ("رَبِّ اجْعَلْنِي مُقِيمَ الصَّلَاةِ وَمِن ذُرِّيَّتِي", "Rabbi ij‘alni muqim as-salati wa min dhurriyyati", "My Lord, make me an establisher of prayer, and from my descendants.", "Qur'an 14:40"),
    ("رَبَّنَا اغْفِرْ لِي وَلِوَالِدَيَّ وَلِلْمُؤْمِنِينَ", "Rabbana ighfir li wa liwalidayya wa lil-mu’minin", "Our Lord, forgive me and my parents and the believers.", "Qur'an 14:41"),
    ("اللَّهُمَّ صَلِّ عَلَى مُحَمَّدٍ وَآلِ مُحَمَّدٍ", "Allahumma salli ‘ala Muhammadin wa Ali Muhammad", "O Allah, send blessings upon Muhammad and the family of Muhammad.", "Salawat"),
    ("رَبَّنَا تَقَبَّلْ مِنَّا إِنَّكَ أَنتَ السَّمِيعُ الْعَلِيمُ", "Rabbana taqabbal minna innaka antas-sami‘ul-‘alim", "Our Lord, accept this from us; indeed You are the Hearing, the Knowing.", "Qur'an 2:127"),
    ("رَبِّ إِنِّي لِمَا أَنزَلْتَ إِلَيَّ مِنْ خَيْرٍ فَقِيرٌ", "Rabbi inni lima anzalta ilayya min khayrin faqir", "My Lord, indeed I am, for whatever good You send me, in need.", "Qur'an 28:24"),
    ("رَبَّنَا أَفْرِغْ عَلَيْنَا صَبْرًا وَثَبِّتْ أَقْدَامَنَا", "Rabbana afrigh ‘alayna sabran wa thabbit aqdamana", "Our Lord, pour upon us patience and make our steps firm.", "Qur'an 2:250"),
    ("رَبِّ نَجِّنِي مِنَ الْقَوْمِ الظَّالِمِينَ", "Rabbi najjini minal-qawmi-z-zalimin", "My Lord, save me from the wrongdoing people.", "Qur'an 28:21"),
    ("رَبَّنَا لَا تَجْعَلْنَا فِتْنَةً لِّلْقَوْمِ الظَّالِمِينَ", "Rabbana la taj‘alna fitnatan lil-qawmi-z-zalimin", "Our Lord, make us not a trial for the wrongdoing people.", "Qur'an 10:85"),
    ("رَبِّ هَبْ لِي مِنَ الصَّالِحِينَ", "Rabbi hab li minas-salihin", "My Lord, grant me from among the righteous.", "Qur'an 37:100"),
    ("رَبَّنَا هَبْ لَنَا مِنْ أَزْوَاجِنَا وَذُرِّيَّاتِنَا قُرَّةَ أَعْيُنٍ", "Rabbana hab lana min azwajina wa dhurriyyatina qurrata a‘yun", "Our Lord, grant us from our spouses and offspring comfort to our eyes.", "Qur'an 25:74"),
    ("رَبِّ اغْفِرْ وَارْحَمْ وَأَنتَ خَيْرُ الرَّاحِمِينَ", "Rabbi ighfir warham wa anta khayrur-rahimin", "My Lord, forgive and have mercy, for You are the best of the merciful.", "Qur'an 23:118"),
    ("رَبَّنَا وَسِعْتَ كُلَّ شَيْءٍ رَّحْمَةً وَعِلْمًا", "Rabbana wasi‘ta kulla shay’in rahmatan wa ‘ilma", "Our Lord, You have encompassed all things in mercy and knowledge.", "Qur'an 40:7"),
    ("رَبِّ أَوْزِعْنِي أَنْ أَشْكُرَ نِعْمَتَكَ", "Rabbi awzi‘ni an ashkura ni‘matak", "My Lord, enable me to be grateful for Your favour.", "Qur'an 27:19"),
    ("رَبَّنَا لَا تُزِغْ قُلُوبَنَا بَعْدَ إِذْ هَدَيْتَنَا", "Rabbana la tuzigh qulubana ba‘da idh hadaytana", "Our Lord, let not our hearts deviate after You have guided us.", "Qur'an 3:8"),
    ("رَبِّ هَبْ لِي حُكْمًا وَأَلْحِقْنِي بِالصَّالِحِينَ", "Rabbi hab li hukman wa alhiqni bis-salihin", "My Lord, grant me wisdom and join me with the righteous.", "Qur'an 26:83"),
    ("اللَّهُمَّ عَجِّلْ لِوَلِيِّكَ الْفَرَجَ", "Allahumma ‘ajjil li-waliyyikal-faraj", "O Allah, hasten the relief of Your awaited guardian (Imam al-Mahdi).", "Du‘a al-Faraj"),
    ("رَبَّنَا آمَنَّا فَاغْفِرْ لَنَا وَارْحَمْنَا", "Rabbana amanna faghfir lana warhamna", "Our Lord, we have believed, so forgive us and have mercy upon us.", "Qur'an 23:109"),
    ("رَبِّ اجْعَلْ هَٰذَا بَلَدًا آمِنًا", "Rabbi ij‘al hadha baladan amina", "My Lord, make this a secure land.", "Qur'an 2:126"),
    ("رَبَّنَا وَتَقَبَّلْ دُعَاءِ", "Rabbana wa taqabbal du‘a", "Our Lord, and accept my supplication.", "Qur'an 14:40"),
    ("رَبِّ إِنِّي ظَلَمْتُ نَفْسِي فَاغْفِرْ لِي", "Rabbi inni zalamtu nafsi faghfir li", "My Lord, indeed I have wronged myself, so forgive me.", "Qur'an 28:16"),
    ("لَا إِلَٰهَ إِلَّا أَنتَ سُبْحَانَكَ إِنِّي كُنتُ مِنَ الظَّالِمِينَ", "La ilaha illa anta subhanaka inni kuntu minaz-zalimin", "There is no god but You; glory be to You. Indeed, I have been of the wrongdoers.", "Qur'an 21:87"),
    ("رَبَّنَا اغْفِرْ لَنَا ذُنُوبَنَا وَإِسْرَافَنَا فِي أَمْرِنَا", "Rabbana ighfir lana dhunubana wa israfana fi amrina", "Our Lord, forgive us our sins and our excess in our affairs.", "Qur'an 3:147"),
    ("رَبِّ أَدْخِلْنِي مُدْخَلَ صِدْقٍ وَأَخْرِجْنِي مُخْرَجَ صِدْقٍ", "Rabbi adkhilni mudkhala sidqin wa akhrijni mukhraja sidq", "My Lord, cause me to enter a sound entrance and to exit a sound exit.", "Qur'an 17:80"),
    ("اللَّهُمَّ ارْزُقْنِي شَفَاعَةَ الْحُسَيْنِ يَوْمَ الْوُرُودِ", "Allahumma-rzuqni shafa‘atal-Husayni yawmal-wurud", "O Allah, grant me the intercession of al-Husayn on the Day of Arrival.", "Ziyarat"),
    ("رَبِّ زِدْنِي عِلْمًا وَفَهْمًا وَإِيمَانًا", "Rabbi zidni ‘ilman wa fahman wa imana", "My Lord, increase me in knowledge, understanding and faith.", "Du‘a"),
    ("يَا مَنْ بِيَدِهِ مَلَكُوتُ كُلِّ شَيْءٍ", "Ya man biyadihi malakutu kulli shay’", "O He in whose hand is the dominion of all things.", "Du‘a"),
]


def main():
    assert len(DUAS) >= 31, f"need ≥31 duas, got {len(DUAS)}"
    out = []
    for ar, tr, en, src in DUAS[:31]:
        out.append({"ar": ar, "tr": tr, "en": en, "src": src})
    # translate the English meaning into the 4 languages, concurrently
    tasks = [(row, lang) for row in out for lang in LANGS]
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(translate, row["en"], lang): (row, lang) for (row, lang) in tasks}
        for fut in as_completed(futs):
            row, lang = futs[fut]
            try:
                row[lang] = fut.result() or row["en"]
            except Exception:
                row[lang] = row["en"]
    js = "// Auto-generated: 31 short duas in Arabic + translit + 9-language meanings.\n"
    js += "const DUAS31 = " + json.dumps(out, ensure_ascii=False, indent=0) + ";\n"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)
    print(f"wrote {OUT} ({len(out)} duas, langs {LANGS})")


if __name__ == "__main__":
    main()
