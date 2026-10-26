// The Shipo logo lockup: the real wordmark on its navy field with the lime
// rule beneath.
//
// WHY A COMPONENT AND NOT AN IMAGE.
//
// shipousa.com serves the mark as white-on-transparent
// (wp-content/uploads/2021/07/white-transparent-bg.png), so it only reads on
// a dark field. On the navy sidebar it can sit bare; anywhere the page is
// white -- the login screen, a printed statement -- it needs the field, and
// the field plus the lime rule is the lockup. Defining that once means the
// login page and the report header cannot drift apart.
//
// WHAT WAS HERE BEFORE, because it is worth not repeating. public/
// shipo-logo.svg is a REDRAW: someone typed "Shipo" in Arial Black italic
// and put two straight lines under it. It is close enough to pass a glance
// and wrong in every detail -- the real mark has custom letterforms and a
// single underline that sweeps beneath the word and kicks up at the end. The
// first version of this re-skin recoloured that redraw and shipped it as the
// brand. Ophir spotted it immediately.
//
// The PNG here is the genuine asset, downloaded from the site and cropped to
// its alpha bounding box (514x500 with the wordmark floating in transparent
// padding, down to 322x122) so it can be laid out by width alone.
//
// A plain <img>, not next/image: this renders in a print header, and
// next/image lazy-loads, so a logo that has not finished loading is a blank
// space at the top of a client-facing document.

export default function ShipoMark({
  width = 200,
  className = '',
}: {
  width?: number
  className?: string
}) {
  return (
    <div
      className={`shipo-mark ${className}`}
      style={{
        background: '#0B3361',
        borderRadius: 8,
        padding: '16px 20px 12px',
        display: 'inline-block',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/shipo-logo-white.png"
        alt="Shipo"
        style={{ width, display: 'block' }}
      />
      {/* #E0EE47 is the site's lime, read off its own header rule and CTA. */}
      <div
        style={{
          height: 5,
          borderRadius: 3,
          background: '#E0EE47',
          marginTop: 12,
        }}
      />
    </div>
  )
}
