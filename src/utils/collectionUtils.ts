export const escapeRegex = (s: string) => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

export const buildQueryFromRules = (rules: any[], ruleRelation: 'all' | 'any') => {
  if (!rules || rules.length === 0) {
    return { _id: { $in: [] } }; // No match if no rules
  }

  const queries = rules.map(rule => {
    const { field, operator, value } = rule;
    
    // Map rule fields to Product schema fields
    let dbField = '';
    if (field === 'title') dbField = 'name';
    else if (field === 'type') dbField = 'category';
    else if (field === 'tag') dbField = 'tag';
    else if (field === 'vendor') dbField = 'vendor';
    else if (field === 'price') dbField = 'price';
    else if (field === 'compareAtPrice') dbField = 'compareAtPrice';
    else dbField = field; // fallback

    const isNumeric = dbField === 'price' || dbField === 'compareAtPrice';

    // Build the query object for this field
    switch (operator) {
      case 'is equal to':
        if (isNumeric) {
          return { [dbField]: Number(value) || 0 };
        }
        return { [dbField]: { $regex: `^${escapeRegex(value)}$`, $options: 'i' } };
      case 'is not equal to':
        if (isNumeric) {
          return { [dbField]: { $ne: Number(value) || 0 } };
        }
        return { [dbField]: { $not: { $regex: `^${escapeRegex(value)}$`, $options: 'i' } } };
      case 'is greater than':
        return { [dbField]: { $gt: Number(value) || 0 } };
      case 'is less than':
        return { [dbField]: { $lt: Number(value) || 0 } };
      case 'starts with':
        if (isNumeric) {
          return { [dbField]: Number(value) || 0 };
        }
        return { [dbField]: { $regex: `^${escapeRegex(value)}`, $options: 'i' } };
      case 'ends with':
        if (isNumeric) {
          return { [dbField]: Number(value) || 0 };
        }
        return { [dbField]: { $regex: `${escapeRegex(value)}$`, $options: 'i' } };
      case 'contains':
        if (isNumeric) {
          return { [dbField]: Number(value) || 0 };
        }
        return { [dbField]: { $regex: escapeRegex(value), $options: 'i' } };
      case 'does not contain':
        if (isNumeric) {
          return { [dbField]: { $ne: Number(value) || 0 } };
        }
        return { [dbField]: { $not: { $regex: escapeRegex(value), $options: 'i' } } };
      default:
        return {};
    }
  });

  if (ruleRelation === 'any') {
    return { $or: queries };
  } else {
    return { $and: queries };
  }
};
