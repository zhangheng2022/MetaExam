import { Flex, theme } from 'antd';

/** Shared identity for 元考 / MetaExam. Keep text selectable and accessible. */
const markUrl = new URL('../public/brand/mark.png', import.meta.url).href;

export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <img
      src={markUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0, objectFit: 'contain' }}
    />
  );
}

export function ProductBrand() {
  const { token } = theme.useToken();
  return (
    <Flex
      className="product-brand"
      align="center"
      gap={token.marginSM}
      style={{
        flexShrink: 0,
        fontSize: token.fontSizeHeading4,
        fontWeight: token.fontWeightStrong,
      }}
    >
      <BrandMark />
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
        <span>元考</span>
        <small style={{ fontSize: token.fontSizeSM, fontWeight: 400, marginTop: token.marginXXS }}>
          MetaExam
        </small>
      </span>
    </Flex>
  );
}
